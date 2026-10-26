import type {
  ChatParams,
  ContentBlock,
  LLMProvider,
  LLMResponse,
  Message,
  ProviderEvent,
  StopReason,
  ToolDefinition
} from './types'
import { CODEX_BASE_URL, CODEX_CLIENT_VERSION } from './codexConfig'
import { ProviderRequestError } from './requestError'
import { dropInvalidToolCalls } from './history'

/*
 * ChatGPT (Codex) over an OAuth account. The subscription is reached through
 * the Codex backend rather than the public /v1 API, so this adapter speaks the
 * Responses API and streams SSE itself instead of going through the OpenAI SDK
 * (whose chat-completions shape does not match what the backend accepts).
 *
 * The access token is an account token; a refresh is the caller's job.
 */

const ENDPOINT = `${CODEX_BASE_URL}/responses`
const PROVIDER_NAME = 'codex'

type ResponsesInput =
  | { type: 'message'; role: 'user' | 'assistant'; content: ResponsesContent[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

type ResponsesContent =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string }

export function toInput(messages: Message[]): ResponsesInput[] {
  const out: ResponsesInput[] = []
  for (const message of dropInvalidToolCalls(messages, 64)) {
    const parts: ResponsesContent[] = []
    for (const block of message.content) {
      if (block.type === 'text' && block.text !== '') {
        parts.push(
          message.role === 'assistant'
            ? { type: 'output_text', text: block.text }
            : { type: 'input_text', text: block.text }
        )
      } else if (block.type === 'image') {
        parts.push({ type: 'input_image', image_url: `data:${block.mediaType};base64,${block.data}` })
      } else if (block.type === 'tool_use') {
        out.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {})
        })
      } else if (block.type === 'tool_result') {
        out.push({ type: 'function_call_output', call_id: block.toolUseId, output: block.content })
      }
    }
    if (parts.length > 0) out.push({ type: 'message', role: message.role, content: parts })
  }
  return out
}

export function toTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false
  }))
}

function toStopReason(reason: string | null | undefined, hasCalls: boolean): StopReason {
  if (hasCalls) return 'tool_use'
  if (reason === 'max_output_tokens') return 'max_tokens'
  if (reason === 'content_filter') return 'refusal'
  return 'end_turn'
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw === '' ? '{}' : raw)
  } catch {
    return { __malformed_arguments: raw }
  }
}

/** Read complete SSE frames, including split UTF-8 and a final frame without a newline. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  function parse(): Record<string, unknown> | null {
    const payload = data.join('\n')
    data = []
    if (!payload || payload === '[DONE]') return null
    try { return JSON.parse(payload) as Record<string, unknown> }
    catch { throw new Error('Codex returned malformed stream data') }
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (done && buffer && !buffer.endsWith('\n')) buffer += '\n'
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
        else if (line === '') {
          const event = parse()
          if (event !== null) yield event
        }
      }
      if (done) {
        const event = parse()
        if (event !== null) yield event
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export class CodexProvider implements LLMProvider {
  readonly name = PROVIDER_NAME

  constructor(
    private readonly accessToken: string,
    readonly model: string,
    private readonly accountId?: string
  ) {}

  async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
    params.signal.throwIfAborted()
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'openai-beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        'user-agent': `codex_cli_rs/${CODEX_CLIENT_VERSION}`,
        ...(this.accountId !== undefined && this.accountId !== ''
          ? { 'chatgpt-account-id': this.accountId }
          : {})
      },
      body: JSON.stringify({
        model: this.model,
        instructions: params.system,
        input: toInput(params.messages),
        tools: toTools(params.tools),
        tool_choice: 'auto',
        parallel_tool_calls: false,
        store: false,
        stream: true
      }),
      signal: params.signal
    })

    if (!response.ok || response.body === null) {
      const detail = await response.text().catch(() => '')
      if (/not supported when using codex/i.test(detail)) {
        throw new Error(
          `Model "${this.model}" is not available on this ChatGPT plan. Pick another Codex model from the model picker and retry.`
        )
      }
      if (response.status === 429) {
        let body: { error?: { type?: string; resets_at?: number; resets_in_seconds?: number } } = {}
        try { body = JSON.parse(detail) as typeof body } catch { /* unknown error body */ }
        const error = body.error
        const quota = error?.type === 'usage_limit_reached' || /usage.limit|quota.exhausted|insufficient.quota/i.test(detail)
        const now = Date.now()
        const resetAt = typeof error?.resets_at === 'number' && Number.isFinite(error.resets_at) ? error.resets_at * 1000
          : typeof error?.resets_in_seconds === 'number' && Number.isFinite(error.resets_in_seconds) ? now + error.resets_in_seconds * 1000 : undefined
        const retry = response.headers.get('retry-after')
        const seconds = retry === null ? NaN : Number(retry)
        const retryAt = retry !== null ? (Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retry)) : undefined
        throw new ProviderRequestError(quota
          ? 'ChatGPT plan usage limit reached. Wait for its quota reset or use another subscription account. Paid API fallback is disabled in subscription routing.'
          : 'Codex rate limited this request (429). Wait for the account cooldown or use another subscription account.',
        429, 'account', resetAt, retryAt)
      }
      throw new ProviderRequestError(`Codex returned ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`, response.status)

    }

    let text = ''
    const calls = new Map<string, { name: string; args: string }>()
    const order: string[] = []
    const usage: { inputTokens: number; outputTokens: number; cachedTokens?: number } = { inputTokens: 0, outputTokens: 0 }
    let reason: string | null = null
    let finished = false

    for await (const event of sse(response.body)) {
      const type = typeof event.type === 'string' ? event.type : ''
      if (type === 'error' || type === 'response.failed') {
        const failure = event.response as { error?: { message?: string; code?: string } } | undefined
        const direct = event.error as { message?: string; code?: string } | undefined
        const message = failure?.error?.message ?? direct?.message ?? (typeof event.message === 'string' ? event.message : undefined)
        const code = failure?.error?.code ?? direct?.code ?? (typeof event.code === 'string' ? event.code : undefined)
        // Do not serialize the event: it may include input or partial outputs.
        throw new Error(`Codex stream failed${code ? ` (${code})` : ''}: ${message ?? 'provider rejected the response without an error reason'}`)
      }
      if (type === 'response.incomplete') throw new Error('Codex response was incomplete; no tool calls were executed.')
      if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
        text += event.delta
        yield { type: 'text_delta', text: event.delta }
      } else if (type === 'response.output_item.added') {
        const item = event.item as { type?: string; call_id?: string; name?: string } | undefined
        if (item?.type === 'function_call' && typeof item.call_id === 'string') {
          calls.set(item.call_id, { name: item.name ?? '', args: '' })
          order.push(item.call_id)
        }
      } else if (type === 'response.function_call_arguments.delta') {
        const callId = typeof event.call_id === 'string' ? event.call_id : ''
        const existing = calls.get(callId)
        if (existing !== undefined && typeof event.delta === 'string') existing.args += event.delta
      } else if (type === 'response.output_item.done') {
        const item = event.item as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined
        if (item?.type === 'function_call' && typeof item.call_id === 'string') {
          const existing = calls.get(item.call_id) ?? { name: item.name ?? '', args: '' }
          calls.set(item.call_id, {
            name: item.name ?? existing.name,
            args: item.arguments !== undefined && item.arguments !== '' ? item.arguments : existing.args
          })
          if (!order.includes(item.call_id)) order.push(item.call_id)
        }
      } else if (type === 'response.completed') {
        finished = true
        const completed = event.response as
          | { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }; incomplete_details?: { reason?: string } }
          | undefined
        usage.inputTokens = completed?.usage?.input_tokens ?? usage.inputTokens
        usage.outputTokens = completed?.usage?.output_tokens ?? usage.outputTokens
        const cached = completed?.usage?.input_tokens_details?.cached_tokens
        if (typeof cached === 'number' && Number.isFinite(cached)) usage.cachedTokens = cached
        reason = completed?.incomplete_details?.reason ?? reason
      }
    }

    if (!finished) throw new ProviderRequestError('Codex connection closed before the response completed', 503)
    const content: ContentBlock[] = []
    if (text !== '') content.push({ type: 'text', text })
    for (const callId of order) {
      const call = calls.get(callId)
      if (call === undefined) continue
      content.push({ type: 'tool_use', id: callId, name: call.name, input: parseArguments(call.args) })
    }

    const result: LLMResponse = {
      content,
      stopReason: toStopReason(reason, order.length > 0),
      usage
    }
    yield { type: 'response', response: result }
  }
}