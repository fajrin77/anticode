import { requestEffort } from '../effort'
import { thinkingConfig } from './geminiThinking'
import { randomUUID } from 'node:crypto'
import { GEMINI_CLOUD_BASE, geminiHeaders, geminiProject } from '../auth/gemini'
import { toContents, toDeclarations } from './google'
import { ProviderRequestError } from './requestError'
import type { AuthTokens } from '../auth/types'
import type { ChatParams, LLMProvider, LLMResponse, ProviderEvent } from './types'

/*
 * A Gemini plan account, driven through the same endpoint the Gemini CLI uses.
 * The plan also streams tool calls here, so `chat` returns deltas as they
 * arrive; function calls are emitted whole at the end of the turn because the
 * endpoint ships their arguments split across chunks.
 */

interface Candidate {
  content?: { parts?: { text?: string; thought?: boolean; functionCall?: { name?: string; args?: Record<string, unknown> } }[] }
  finishReason?: string
}
interface Chunk {
  candidates?: Candidate[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number }
}

export function geminiCliResponse(chunks: Chunk[], model: string): LLMResponse {
  const content: LLMResponse['content'] = []
  const parts = chunks.flatMap((chunk) => chunk.candidates?.[0]?.content?.parts ?? [])
  const candidate = chunks.map((chunk) => chunk.candidates?.[0]).filter((value): value is Candidate => value !== undefined).at(-1)
  let text = ''
  for (const part of parts) {
    if (part.text && !part.thought) text += part.text
    if (part.functionCall?.name) {
      if (text !== '') { content.push({ type: 'text', text }); text = '' }
      content.push({ type: 'tool_use', id: `gen-${randomUUID()}`, name: part.functionCall.name, input: part.functionCall.args ?? {} })
    }
  }
  if (text !== '') content.push({ type: 'text', text })
  const usage = chunks.map((chunk) => chunk.usageMetadata).filter((value): value is NonNullable<Chunk['usageMetadata']> => value !== undefined).at(-1)
  if (!/^(?:gemini-|gemma-|flash(?:-lite)?$|pro$)/.test(model)) throw new Error('Unsupported Gemini model family')
  const finish = candidate?.finishReason
  return {
    content,
    stopReason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : finish === 'MAX_TOKENS' ? 'max_tokens' : finish && finish !== 'STOP' ? 'refusal' : 'end_turn',
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      cachedTokens: usage?.cachedContentTokenCount ?? 0
    }
  }
}

/** Preserves Google's status and ErrorInfo reasons even when the error message is long. */
function summarizeGeminiError(raw: string): string {
  const compact = raw.replace(/\s+/g, ' ').trim()
  try {
    const parsed = JSON.parse(raw) as unknown
    const entry = (Array.isArray(parsed) ? parsed[0] : parsed) as {
      error?: { status?: string; message?: string; details?: { reason?: string }[] }
    } | null
    const err = entry?.error
    if (err && typeof err === 'object') {
      const reasons = Array.isArray(err.details) ? err.details.map((d) => d?.reason).filter((r): r is string => typeof r === 'string' && r !== '') : []
      const tags = [err.status, ...reasons].filter((v): v is string => typeof v === 'string' && v !== '')
      const msg = typeof err.message === 'string' ? err.message.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
      const summary = [tags.join(' '), msg].filter(Boolean).join(': ')
      if (summary) return summary
    }
  } catch { /* Fall back to compact raw text below. */ }
  return compact.slice(0, 300)
}

export class GeminiCliProvider implements LLMProvider {
  readonly name = 'gemini'
  constructor(private tokens: AuthTokens, readonly model: string) {}

  async *chat(params: ChatParams): AsyncGenerator<ProviderEvent> {
    const project = this.tokens.meta?.project ?? await geminiProject(this.tokens.accessToken, params.signal)
    const response = await fetch(`${GEMINI_CLOUD_BASE}/v1internal:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { ...geminiHeaders(this.tokens.accessToken), Accept: 'text/event-stream' },
      signal: params.signal,
      body: JSON.stringify({
        model: this.model,
        ...(project ? { project } : {}),
        // The endpoint accepts one prompt id per turn and echoes it in traces.
        user_prompt_id: randomUUID(),
        request: {
          contents: toContents(params.messages),
          systemInstruction: { parts: [{ text: params.system }] },
          generationConfig: { maxOutputTokens: params.maxTokens, ...thinkingConfig(requestEffort('gemini', this.model)) },
          ...(params.tools.length ? { tools: [{ functionDeclarations: toDeclarations(params.tools) }] } : {})
        }
      })
    })
    if (!response.ok) {
      // Keep the provider's own status/reason (never the request) so 400/403 is diagnosable.
      const detail = summarizeGeminiError(await response.text().catch(() => ''))
      // A route permission denial does not establish that every model on the account is blocked.
      throw new ProviderRequestError(`Gemini request failed (${response.status})${detail ? `: ${detail}` : ''}`, response.status, response.status === 401 ? 'account' : 'model')
    }

    const chunks: Chunk[] = []
    const decoder = new TextDecoder()
    let buffer = ''
    /** Each SSE event is a wrapper: `{ response: <generateContent chunk> }`. */
    const take = (line: string): string => {
      if (!line.startsWith('data:')) return ''
      const payload = line.slice(5).trim()
      if (payload === '' || payload === '[DONE]') return ''
      let parsed: { response?: Chunk } | Chunk
      try { parsed = JSON.parse(payload) as { response?: Chunk } | Chunk } catch { return '' }
      const chunk = (parsed as { response?: Chunk }).response ?? parsed as Chunk
      chunks.push(chunk)
      return (chunk.candidates?.[0]?.content?.parts ?? []).map((part) => part.thought ? '' : part.text ?? '').join('')
    }
    const reader = response.body?.getReader()
    if (reader === undefined) throw new ProviderRequestError('Gemini returned no response body', 502, 'model')
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const text = take(line.trimEnd())
          if (text !== '') yield { type: 'text_delta', text }
        }
      }
      const tail = take(buffer.trimEnd())
      if (tail !== '') yield { type: 'text_delta', text: tail }
    } finally { await reader.cancel().catch(() => {}) }

    // The text already reached the loop as deltas; this turn's own copy of it
    // must not be appended a second time, so only tool calls ride along here.
    const result = geminiCliResponse(chunks, this.model)
    yield { type: 'response', response: { ...result, content: result.content.filter((block) => block.type !== 'text') } }
  }
}
