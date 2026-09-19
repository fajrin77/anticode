import Anthropic from '@anthropic-ai/sdk'
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
import { dropInvalidToolCalls } from './history'

const PROVIDER_NAME = 'anthropic'

/**
 * The exact identity the official CLI sends on OAuth traffic (mirrored from
 * working setups against this backend). Without it, plan traffic gets
 * throttled even with quota left. Only used for OAuth accounts, never keys.
 */
export const CLAUDE_CODE_HEADERS: Record<string, string> = {
  'anthropic-beta':
    'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28',
  'anthropic-dangerous-direct-browser-access': 'true',
  'user-agent': 'claude-cli/2.1.8 (external, sdk-cli)',
  'x-app': 'cli'
}

function toBlockParam(block: ContentBlock): Anthropic.ContentBlockParam | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'image':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mediaType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
          data: block.data
        }
      }
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError
      }
    case 'display':
      return null
    case 'opaque':
      return block.provider === PROVIDER_NAME
        ? (block.raw as Anthropic.ContentBlockParam)
        : null
  }
}

function toMessageParams(messages: Message[]): Anthropic.MessageParam[] {
  // Anthropic rejects tool_use names over 200 chars, even deep in history.
  return dropInvalidToolCalls(messages, 200).flatMap((message) => {
    const content = message.content
      .map(toBlockParam)
      .filter((block): block is Anthropic.ContentBlockParam => block !== null)
    return content.length === 0 ? [] : [{ role: message.role, content }]
  })
}

/**
 * Anthropic re-bills the whole prefix on every request unless a breakpoint
 * marks it cacheable. The system prompt and tool schemas are identical on
 * every turn of a session, so the last tool carries the breakpoint that lets
 * the model read the entire prefix from cache instead.
 */
function toToolParams(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    ...(index === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {})
  }))
}

/**
 * The system prompt is the first stable block of every request: caching it
 * means later turns reuse both the instructions and the tools that follow.
 * An empty prompt is left out entirely rather than sent as an empty block.
 */
function toSystemParam(system: string): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
}

function fromContentBlock(block: Anthropic.ContentBlock): ContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (block.type === 'tool_use') {
    return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
  }
  return { type: 'opaque', provider: PROVIDER_NAME, raw: block }
}

function toStopReason(reason: Anthropic.Message['stop_reason']): StopReason {
  if (reason === 'tool_use') return 'tool_use'
  if (reason === 'max_tokens') return 'max_tokens'
  if (reason === 'refusal') return 'refusal'
  return 'end_turn'
}

/**
 * The SDK adds /v1 itself; a Base URL pasted with it would call /v1/v1/…
 * and every request would come back 404.
 */
export function anthropicBaseURL(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

/** Each model's own output ceiling, asked of the Models API once per key and model. */
const outputCaps = new Map<string, Promise<number | null>>()

export class AnthropicProvider implements LLMProvider {
  readonly name = PROVIDER_NAME

  private readonly client: Anthropic
  private readonly capKey: string

  constructor(
    apiKey: string,
    readonly model: string,
    baseURL?: string,
    extra?: { authToken?: string; defaultHeaders?: Record<string, string> }
  ) {
    this.client = new Anthropic({
      // An OAuth account sends its access token as a Bearer header rather than
      // an x-api-key; the SDK's authToken is exactly that, and it replaces the
      // key entirely.
      ...(extra?.authToken !== undefined
        ? { authToken: extra.authToken, apiKey: null }
        : { apiKey }),
      ...(baseURL !== undefined ? { baseURL: anthropicBaseURL(baseURL) } : {}),
      ...(extra?.defaultHeaders !== undefined ? { defaultHeaders: extra.defaultHeaders } : {})
    })
    this.capKey = `${baseURL ?? ''}\n${(extra?.authToken ?? apiKey).slice(-8)}\n${model}`
  }

  /**
   * The loop asks for 32K output tokens. Current models take far more, but an
   * older one picked from the catalogue would reject the request outright, so
   * the ask is lowered to what the model says it allows. Not knowing is not a
   * reason to fail: the request then goes out as asked.
   */
  private outputCap(): Promise<number | null> {
    let cap = outputCaps.get(this.capKey)
    if (cap === undefined) {
      cap = this.client.models
        .retrieve(this.model)
        .then((info) => info.max_tokens ?? null)
        .catch(() => null)
      outputCaps.set(this.capKey, cap)
    }
    return cap
  }

  async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
    const cap = await this.outputCap()
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: cap !== null ? Math.min(params.maxTokens, cap) : params.maxTokens,
        ...(params.system === '' ? {} : { system: toSystemParam(params.system) }),
        tools: toToolParams(params.tools),
        messages: toMessageParams(params.messages)
      },
      { signal: params.signal }
    )

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text }
        }
      }

      const final = await stream.finalMessage()
      const response: LLMResponse = {
        content: final.content.map(fromContentBlock),
        stopReason: toStopReason(final.stop_reason),
        usage: {
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens
        }
      }
      yield { type: 'response', response }
    } catch (error) {
      throw friendlyError(this.model, error)
    }
  }
}

/**
 * Raw vendor errors read as JSON soup in the transcript. 404 almost always
 * means the model id is wrong — often a router-style `prefix/id` that no
 * direct backend accepts — and 429 means the plan quota ran out. Anything
 * else, including 401s (the OAuth wrapper retries those itself) and cancels,
 * passes through untouched.
 */
function friendlyError(model: string, error: unknown): Error {
  if (error instanceof Error && (error.name === 'AbortError' || /aborted|cancelled/i.test(error.message))) {
    return error
  }
  const status = (error as { status?: unknown })?.status
  if (status !== 404 && status !== 429) return error instanceof Error ? error : new Error(String(error))
  if (status === 429) {
    // Wording matters: "quota exhausted" would trip the spent-quota detector
    // and mark the model out of usage. A 429 is usually per-minute, not empty.
    // The SDK exposes headers as a Headers instance, not a plain record.
    const rawHeaders = (error as { headers?: unknown })?.headers
    const retryAfter =
      (typeof rawHeaders === 'object' && rawHeaders !== null && 'get' in rawHeaders
        ? (rawHeaders as { get: (name: string) => string | null }).get('retry-after')
        : (rawHeaders as Record<string, unknown> | undefined)?.['retry-after']) ??
      (error as { retryAfter?: unknown })?.retryAfter
    const wait = typeof retryAfter === 'string' || typeof retryAfter === 'number'
      ? `Retry after ${retryAfter}s`
      : 'Wait a minute and retry'
    // Keep the vendor's own detail (limits, reset time) when it does not look
    // like spent quota; otherwise it would mislead and trip the detector.
    const vendor = vendorDetail(error)
    const reset = ratelimitReset(error)
    // No reset timestamps at all means this is not a standard throttle: the
    // plan itself does not serve this model over OAuth (a smaller model on
    // the same account works). Say so instead of sending the user to wait
    // out a reset that is not coming.
    const friendly = new Error(
      reset === ''
        ? `Claude refused "${model}" over OAuth (429, no reset time given). This plan serves other models — try claude-haiku-4-5 or a Codex model instead.${vendor === '' ? '' : ` Vendor says: ${vendor}`}`
        : `Claude rate limited this request (429). ${wait} — or put this account in Rotate usage with another model as backup.${vendor === '' ? '' : ` Vendor says: ${vendor}`} ${reset}`
    )
    // Keep the status so the agent loop still sees this as transient and
    // retries automatically instead of failing the turn at once.
    ;(friendly as { status?: unknown }).status = 429
    if (retryAfter !== undefined && retryAfter !== null) {
      ;(friendly as { retryAfter?: unknown }).retryAfter = retryAfter
    }
    ;(friendly as { cause?: unknown }).cause = error
    return friendly
  }
  const routerHint = model.includes('/')
    ? ' Router-style ids like "cc/..." only work through a router; a direct account needs the bare id.'
    : ''
  return new Error(
    `Model "${model}" does not exist on this account (404). Pick one from the model picker, e.g. claude-sonnet-5.${routerHint}`
  )
}

/**
 * Anthropic's own reset timestamps say whether a 429 is per-minute or an
 * empty plan: requests/tokens reset versus a far-future date. Carried into
 * the message so the transcript itself settles it.
 */
function ratelimitReset(error: unknown): string {
  const rawHeaders = (error as { headers?: unknown })?.headers
  const get = (name: string): string | null => {
    if (typeof rawHeaders === 'object' && rawHeaders !== null && 'get' in rawHeaders) {
      try {
        return (rawHeaders as { get: (name: string) => string | null }).get(name)
      } catch {
        return null
      }
    }
    const value = (rawHeaders as Record<string, unknown> | undefined)?.[name]
    return typeof value === 'string' ? value : null
  }
  const parts: string[] = []
  const requests = get('anthropic-ratelimit-requests-reset')
  const tokens = get('anthropic-ratelimit-tokens-reset')
  if (requests !== null || tokens !== null) {
    parts.push(`limits reset requests=${requests ?? '?'} tokens=${tokens ?? '?'}`)
  }
  const requestId = get('request-id')
  if (requestId !== null) parts.push(`request ${requestId}`)
  return parts.length > 0 ? `(${parts.join(', ')})` : ''
}

/**
 * What the vendor itself attached to a 429 (message, limit, reset). A couple
 * of samples: `Rate limit reached for gpt-4 … Limit 20000, Used 19876 …
 * Requested 2011. Please try again in 58ms`, `{"error":{"type":
 * "rate_limit_error","message":"Number of request tokens has exceeded your
 * credit balance. Please add credit…"}}`. Spent-looking text counts as
 * nothing here so it can never nudge the spent-quota wording above it.
 */
function vendorDetail(error: unknown): string {
  const pick = (value: unknown): string => {
    if (typeof value !== 'string') return ''
    if (/(quota|exhaust|exceed.*(current|monthly).*quota|credit balance|insufficient|out of (credits?|quota|tokens)|usage limit|spend(?:ing)? limit|payment required)/i.test(value)) return ''
    return value.replace(/\s+/g, ' ').trim().slice(0, 220)
  }
  const record = error as { message?: unknown; error?: unknown } | null
  if (record === null || typeof record !== 'object') return ''
  const inner = record.error as { message?: unknown; error?: unknown } | undefined
  return (
    pick(typeof inner === 'object' && inner !== null ? inner.message ?? inner.error : undefined) ||
    pick(typeof record.message === 'string' && /^\d+\s/.test(record.message)
      ? record.message.slice(record.message.indexOf(' ') + 1)
      : undefined)
  )
}
