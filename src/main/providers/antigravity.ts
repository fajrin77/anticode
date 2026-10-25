import { randomUUID } from 'node:crypto'
import { ANTIGRAVITY_BASE, antigravityHeaders, antigravityProject } from '../auth/antigravity'
import { toContents, toDeclarations } from './google'
import { ProviderRequestError } from './requestError'
import type { AuthTokens } from '../auth/types'
import type { ChatParams, LLMProvider, LLMResponse, ProviderEvent } from './types'

export function antigravityResponse(body: unknown, model: string): LLMResponse {
  const outer = body as { response?: unknown }
  const data = (outer.response ?? body) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean; functionCall?: { name?: string; args?: Record<string, unknown> } }[] }; finishReason?: string }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } }
  const candidate = data.candidates?.[0]
  if (!candidate) throw new Error('Antigravity returned no candidate')
  const content: LLMResponse['content'] = []
  for (const part of candidate.content?.parts ?? []) {
    if (part.text && !part.thought) content.push({ type: 'text', text: part.text })
    if (part.functionCall?.name) content.push({ type: 'tool_use', id: `gen-${randomUUID()}`, name: part.functionCall.name, input: part.functionCall.args ?? {} })
  }
  if (!model.startsWith('gemini-')) throw new Error('Unsupported Antigravity model family')
  return { content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : candidate.finishReason === 'MAX_TOKENS' ? 'max_tokens' : candidate.finishReason && candidate.finishReason !== 'STOP' ? 'refusal' : 'end_turn', usage: { inputTokens: data.usageMetadata?.promptTokenCount ?? 0, outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0, cachedTokens: data.usageMetadata?.cachedContentTokenCount ?? 0 } }
}
export class AntigravityProvider implements LLMProvider {
  readonly name = 'antigravity'
  constructor(private tokens: AuthTokens, readonly model: string) {}
  private async response(params: ChatParams): Promise<LLMResponse> {
    const project = this.tokens.meta?.project ?? await antigravityProject(this.tokens.accessToken, params.signal)
    const response = await fetch(`${ANTIGRAVITY_BASE}/v1internal:generateContent`, {
      method: 'POST', headers: antigravityHeaders(this.tokens.accessToken), signal: params.signal,
      body: JSON.stringify({ project, model: this.model, userAgent: 'anticode', requestType: 'agent', requestId: randomUUID(), request: { contents: toContents(params.messages), systemInstruction: { parts: [{ text: params.system }] }, generationConfig: { maxOutputTokens: params.maxTokens }, ...(params.tools.length ? { tools: [{ functionDeclarations: toDeclarations(params.tools) }] } : {}) } })
    })
    if (!response.ok) throw new ProviderRequestError(`Antigravity request failed (${response.status})`, response.status, response.status === 401 || response.status === 403 ? 'account' : 'model')
    return antigravityResponse(await response.json(), this.model)
  }
  async *chat(params: ChatParams): AsyncGenerator<ProviderEvent> {
    // Buffered generateContent: avoids dropping function-call and thought metadata
    // between SSE chunks. This adapter deliberately does not claim token streaming.
    const result = await this.response(params)
    for (const part of result.content) {
      if (part.type === 'text') yield { type: 'text_delta', text: part.text }
    }
    yield { type: 'response', response: result }
  }
}
