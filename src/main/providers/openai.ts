import OpenAI from 'openai'
import { isAccountAccessFailure } from './failures'
import { modelCannotSeeImages } from '@shared/ipc'
import { ProviderRequestError } from './requestError'
import { InputRequestLimitError, requestLimit } from './requestLimits'
import { isRetiredRoute, RetiredRouteError } from './routeError'
import type {
  ChatParams,
  ContentBlock,
  LLMProvider,
  LLMResponse,
  Message,
  ImageGenerationParams,
  GeneratedImage,
  ProviderEvent,
  StopReason,
  ToolDefinition
} from './types'
import { dropInvalidToolCalls } from './history'

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

/** Move to the next Rotate provider when a request has produced no useful data. */
export const FIRST_DATA_TIMEOUT_MS = 60_000
/** Once output has begun, allow long generations to keep progressing. */
export const STREAM_INACTIVITY_MS = 180_000

/** Cline wraps upstream failures in a successful SSE response, sometimes with
 * an outer 404 hiding an earlier provider 429. Inspect only bounded error fields.
 */
function clineStreamFailure(message: string): ProviderRequestError {
  const bounded = message.slice(0, 65_536)
  const outerStatus = /(?:status|HTTP)\s+(4\d\d|5\d\d)\b/i.exec(bounded)?.[1]
  const status = outerStatus ? Number(outerStatus) : 502
  let rateLimited = false
  let nested429 = false
  const pending: { value: unknown; depth: number }[] = [{ value: bounded, depth: 0 }]
  let remainingCharacters = 65_536
  for (let count = 0; pending.length && count < 64; count++) {
    const { value, depth } = pending.shift()!
    if (depth > 8) continue
    if (typeof value === 'string') {
      const text = value.slice(0, remainingCharacters)
      remainingCharacters -= text.length
      rateLimited ||= /rate[- ]limit(?:ed|ing)?\b/i.test(text)
      // The upstream JSON follows the human-readable Cline error prefix.
      const start = text.indexOf('{')
      if (start >= 0) {
        try { pending.push({ value: JSON.parse(text.slice(start)), depth: depth + 1 }) } catch { /* plain error text */ }
      }
    } else if (Array.isArray(value)) {
      pending.push(...value.slice(0, 16).map((item) => ({ value: item, depth: depth + 1 })))
    } else if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      nested429 ||= record.code === 429 || record.status === 429 || record.code === '429' || record.status === '429'
      for (const key of ['error', 'metadata', 'previous_errors', 'raw', 'message']) {
        if (key in record) pending.push({ value: record[key], depth: depth + 1 })
      }
    }
  }
  if (status === 429 || (status === 404 && nested429 && rateLimited)) {
    return new ProviderRequestError('This free model is temporarily rate limited upstream. Retry later or choose another free model.', 429)
  }
  // Preserve explicit product-surface restrictions for AuthProvider to handle.
  return new ProviderRequestError(message, status)
}

/**
 * Anthropic groups every tool result into one user message; OpenAI wants one
 * message per result with role "tool". Splitting them is this adapter's job.
 */
function toChatMessages(system: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }]

  // OpenAI caps function names at 64 chars, including in replayed history.
  for (const message of dropInvalidToolCalls(messages, 64)) {
    if (message.role === 'assistant') {
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      const toolCalls = message.content.filter((block) => block.type === 'tool_use')

      if (text === '' && toolCalls.length === 0) continue

      out.push({
        role: 'assistant',
        content: text === '' ? null : text,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((block) => ({
                id: block.id,
                type: 'function' as const,
                function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
              }))
            }
          : {})
      })
      continue
    }

    for (const block of message.content) {
      if (block.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content })
      }
    }

    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = []
    for (const block of message.content) {
      if (block.type === 'text' && block.text !== '') {
        parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${block.mediaType};base64,${block.data}` }
        })
      }
    }
    if (parts.length > 0) out.push({ role: 'user', content: parts })
  }

  return out
}

function toChatTools(tools: ToolDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }))
}

function toStopReason(reason: string | null | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls || reason === 'tool_calls') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'content_filter') return 'refusal'
  return 'end_turn'
}

function parseArguments(raw: string): unknown {
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    // Surfaced to the model as a tool input validation error rather than crashing.
    return { __malformed_arguments: raw }
  }
}

/** "…but can only afford 9269": the output budget OpenRouter would accept, with a little headroom. */
export function affordableTokens(error: unknown): number | null {
  const record = error as { status?: unknown; message?: unknown } | null
  if (record?.status !== 402 || typeof record.message !== 'string') return null
  const match = /can only afford (\d+)/i.exec(record.message)
  const affordable = match === null ? 0 : Math.floor(Number(match[1]) * 0.95)
  return affordable >= 256 ? affordable : null
}

export class OpenAICompatibleProvider implements LLMProvider {
  private readonly client: OpenAI

  constructor(
    readonly name: string,
    readonly model: string,
    options: {
      apiKey: string
      baseURL?: string
      maxTokensField: 'max_completion_tokens' | 'max_tokens'
      /** Extra headers a vendor needs (CodeBuddy's X-Domain, for instance). */
      defaultHeaders?: Record<string, string>
      /** Public free endpoints only; never used as fallback for a rejected key. */
      anonymous?: boolean
      /** Test hook; production uses FIRST_DATA_TIMEOUT_MS. */
      firstDataTimeoutMs?: number
      /** Test hook; production uses STREAM_INACTIVITY_MS. */
      streamInactivityMs?: number
    }
  ) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      defaultHeaders: { ...options.defaultHeaders, ...(options.anonymous ? { Authorization: null } : {}) }
    })
    this.maxTokensField = options.maxTokensField
    this.firstDataTimeoutMs = options.firstDataTimeoutMs ?? FIRST_DATA_TIMEOUT_MS
    this.streamInactivityMs = options.streamInactivityMs ?? STREAM_INACTIVITY_MS
  }

  private readonly maxTokensField: 'max_completion_tokens' | 'max_tokens'
  private readonly firstDataTimeoutMs: number
  private readonly streamInactivityMs: number

  async generateImage(params: ImageGenerationParams): Promise<GeneratedImage> {
    params.signal.throwIfAborted()
    const response = await this.client.images.generate(
      {
        model: params.model,
        prompt: params.prompt,
        n: 1,
        output_format: 'png',
        quality: params.quality,
        size: params.size
      },
      { signal: params.signal }
    )
    const image = response.data?.[0]
    if (image === undefined) throw new Error('The image provider returned no image')

    let data = image.b64_json
    let mediaType = 'image/png'
    if (data === undefined && image.url !== undefined) {
      const downloaded = await fetch(image.url, { signal: params.signal })
      if (!downloaded.ok) throw new Error(`Failed to download generated image: HTTP ${downloaded.status}`)
      const bytes = Buffer.from(await downloaded.arrayBuffer())
      if (bytes.length === 0) throw new Error('The image provider returned an empty image')
      if (bytes.length > 30 * 1024 * 1024) throw new Error('The generated image is larger than 30 MB')
      data = bytes.toString('base64')
      mediaType = downloaded.headers.get('content-type')?.split(';')[0] || mediaType
    }
    if (data === undefined || Buffer.from(data, 'base64').length === 0) {
      throw new Error('The image provider returned no image bytes')
    }
    return {
      data,
      mediaType,
      ...(image.revised_prompt !== undefined ? { revisedPrompt: image.revised_prompt } : {})
    }
  }

  async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
    if (modelCannotSeeImages(this.model) && params.messages.some((message) => message.content.some((block) => block.type === 'image'))) {
      throw new ProviderRequestError(`${this.model} cannot inspect images in this conversation. Choose a vision model or start a text-only chat.`, 400)
    }
    params.signal.throwIfAborted()
    // Some OpenAI-compatible gateways reject an empty tools array, so the key
    // is omitted entirely when there is nothing to offer (chat mode).
    const tools = params.tools.length > 0 ? toChatTools(params.tools) : undefined

    // A stalled connection would otherwise hang the whole run: abort when no
    // chunk arrives for a while. A stall before anything streamed is treated
    // as transient (the loop retries); a stall mid-stream is a hard error, so
    // the turn is never silently duplicated.
    const watchdog = new AbortController()
    const onOuterAbort = (): void => watchdog.abort()
    params.signal.addEventListener('abort', onOuterAbort, { once: true })
    let received = false
    let inactivity: ReturnType<typeof setTimeout> | null = null
    const bump = (): void => {
      if (inactivity !== null) clearTimeout(inactivity)
      inactivity = setTimeout(
        () => watchdog.abort(),
        received ? this.streamInactivityMs : this.firstDataTimeoutMs
      )
    }
    bump()

    let text = ''
    let finishReason: string | null = null
    const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }
    const calls = new Map<number, { id: string; name: string; args: string }>()
    const stalled = (): Error => received
      ? new ProviderRequestError('Provider stream stalled mid-turn. The run stopped so nothing is duplicated', 503)
      : Object.assign(new Error('Provider stream stalled before any data arrived'), { status: 503 })

    try {
      const open = (maxTokens: number) => this.client.chat.completions.create(
        {
          model: this.model,
          messages: toChatMessages(params.system, params.messages),
          ...(tools !== undefined ? { tools } : {}),
          stream: true,
          stream_options: { include_usage: true },
          [this.maxTokensField]: maxTokens
        },
        { signal: watchdog.signal }
      )
      // OpenRouter answers 402 when the requested output budget costs more
      // than the credit left, and names what the account can afford. That is
      // not a spent key: ask again for what fits.
      const stream = await open(params.maxTokens).catch((error: unknown) => {
        const affordable = affordableTokens(error)
        if (affordable === null || affordable >= params.maxTokens) throw error
        return open(affordable)
      })

      for await (const chunk of stream) {
        if (chunk.usage) {
          usage.inputTokens = chunk.usage.prompt_tokens
          usage.outputTokens = chunk.usage.completion_tokens
          const cached = (chunk.usage as { prompt_tokens_details?: { cached_tokens?: unknown } })
            .prompt_tokens_details?.cached_tokens
          if (typeof cached === 'number' && Number.isFinite(cached)) usage.cachedTokens = cached
          // Some gateways (Anthropic-style caching) report prompt_tokens without the
          // cached part; cache can never exceed the whole prompt, so top it up.
          if (usage.cachedTokens > usage.inputTokens) usage.inputTokens += usage.cachedTokens
        }

        const choice = chunk.choices[0]
        if (!choice) continue
        if (choice.finish_reason) finishReason = choice.finish_reason

        const delta = choice.delta.content
        if (typeof delta === 'string' && delta !== '') {
          received = true
          text += delta
          yield { type: 'text_delta', text: delta }
        }

        for (const call of choice.delta.tool_calls ?? []) {
          received = true
          const existing = calls.get(call.index) ?? { id: '', name: '', args: '' }
          calls.set(call.index, {
            id: call.id || existing.id,
            name: call.function?.name || existing.name,
            args: existing.args + (call.function?.arguments ?? '')
          })
        }
        // Useful text or a tool call switches from the short first-data guard
        // to the longer mid-stream guard. Empty keepalive chunks do not.
        bump()
      }
    } catch (error) {
      if (params.signal.aborted) throw error
      if (isRetiredRoute(error)) throw new RetiredRouteError(this.model)
      const limit = requestLimit(error)
      if (limit?.kind === 'input') {
        throw new InputRequestLimitError(limit.promptTokens ?? 0, limit.limitTokens ?? 0)
      }
      if (isAccountAccessFailure(error)) throw Object.assign(error as object, { scope: 'account' })
      if (watchdog.signal.aborted && !params.signal.aborted) throw stalled()
      // Cline can send an upstream HTTP failure inside a 200 SSE response.
      const streamError = error as { error?: { code?: unknown }; message?: unknown } | null
      if ((this.name === 'cline' || this.name === 'clinepass') && streamError?.error?.code === 'stream_initialization_failed' && typeof streamError.message === 'string') {
        throw clineStreamFailure(streamError.message)
      }
      throw error
    } finally {
      if (inactivity !== null) clearTimeout(inactivity)
      params.signal.removeEventListener('abort', onOuterAbort)
    }
    // Some OpenAI-compatible SDK streams end their iterator cleanly on abort
    // instead of throwing. It is still a stall and must reach Rotate fallback.
    if (watchdog.signal.aborted && !params.signal.aborted) throw stalled()

    if (finishReason === null) throw new ProviderRequestError('Provider stream ended before completion; no partial tool calls were executed.', 503)
    const content: ContentBlock[] = []
    if (text !== '') content.push({ type: 'text', text })
    for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      content.push({
        type: 'tool_use',
        id: call.id !== '' ? call.id : `call_${index}`,
        name: call.name,
        input: parseArguments(call.args)
      })
    }

    if (content.length === 0) {
      throw new ProviderRequestError('The model returned no answer or tool call. Choose another model or retry with a larger output budget.', 502)
    }

    const response: LLMResponse = {
      content,
      stopReason: toStopReason(finishReason, calls.size > 0),
      usage
    }
    yield { type: 'response', response }
  }
}
