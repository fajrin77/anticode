import { randomUUID } from 'node:crypto'
import { APP_VERSION } from '../version'
import { OpenAICompatibleProvider } from './openai'
import { ResponsesProvider } from './responses'
import { AnthropicProvider } from './anthropic'
import { GoogleProvider } from './google'
import { ProviderRequestError } from './requestError'
import type { ChatParams, LLMProvider, ProviderEvent } from './types'

export const GO_BASE = 'https://opencode.ai/inference/go'
/** Official Go endpoint table, checked 2026-10-21. No Zen/PAYG endpoint fallback. */
export const GO_ROUTES = {
  'minimax-m3.1-flash-free': 'chat', 'beam-free': 'chat', 'longcat-2.5-preview-free': 'chat',
  'glm-5.3-flash': 'chat', 'glm-5.3': 'chat', 'glm-5.2': 'chat',
  'kimi-k3': 'chat', 'kimi-k2.7-code': 'chat', 'longcat-2.0': 'chat',
  'deepseek-v4.1-flash': 'chat', 'deepseek-v4-pro': 'chat',
  'mimo-v2.6-flash': 'chat', 'mimo-v2.6-pro': 'chat', 'mimo-v2.5': 'chat', 'mimo-v2.5-pro': 'chat',
  'hy4-preview': 'chat', 'hy3': 'chat', 'step-5-preview': 'chat',
  'grok-4.7': 'responses', 'gpt-6-luna': 'responses', 'gpt-5.6-luna': 'responses',
  'muse-spark-1.3-contributor': 'responses', 'muse-spark-1.2-contributor': 'responses',
  'minimax-m3': 'anthropic', 'qwen3.8-max': 'anthropic', 'qwen3.8-flash': 'anthropic',
  'qwen3.7-plus': 'anthropic', 'claude-haiku-5-5': 'anthropic',
  'gemini-4-argon-contributor': 'google'
} as const
export function goModels(): string[] { return Object.keys(GO_ROUTES) }
export function goHeaders(sessionId: string): Record<string, string> {
  return { 'user-agent': `anticode/${APP_VERSION}`, 'x-opencode-session': sessionId }
}

export function isOpenCodeEndpoint(baseURL: string): boolean {
  try {
    const url = new URL(baseURL)
    return url.protocol === 'https:' && url.hostname === 'opencode.ai' && (url.pathname.startsWith('/zen/') || url.pathname.startsWith('/inference/'))
  } catch { return false }
}

/** Custom providers need the same session metadata as the native Go adapter. */
export function withOpenCodeSession(model: string, baseURL: string, create: (headers?: Record<string, string>) => LLMProvider): LLMProvider {
  const primary = create()
  if (!isOpenCodeEndpoint(baseURL)) return primary
  const fallback = randomUUID()
  return {
    name: primary.name, model,
    ...(primary.generateImage ? { generateImage: (params: Parameters<NonNullable<LLMProvider['generateImage']>>[0]) => create(goHeaders(fallback)).generateImage!(params) } : {}),
    async *chat(params) {
      try { yield* create(goHeaders(params.sessionId || fallback)).chat(params) }
      catch (error) { throw openCodeAccessError(error) }
    }
  }
}

function openCodeAccessError(error: unknown): unknown {
  const text = error instanceof Error ? error.message : String(error)
  if (/free tier can only be used from within OpenCode/i.test(text)) return new ProviderRequestError('OpenCode membatasi Free ke aplikasi resminya. Login atau Renew di Anticode tidak membuka akses ini. Gunakan OpenCode resmi, atau pilih provider gratis lain yang sudah Anda hubungkan.', 403)
  if (/active OpenCode Go subscription is required/i.test(text)) return new ProviderRequestError('Endpoint ini memerlukan subscription OpenCode Go aktif. Nama model dengan akhiran free tidak memberikan akses Go. Hubungkan key Go di Auth provider jika Anda memiliki paket tersebut.', 403)
  return error
}
export class OpenCodeGoProvider implements LLMProvider {
  readonly name = 'OpenCode Go'
  private readonly fallbackSession = randomUUID()
  constructor(private readonly key: string, readonly model: string) {}
  async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
    const protocol = GO_ROUTES[this.model as keyof typeof GO_ROUTES]
    if (!protocol) throw new Error('This model has no supported OpenCode Go route. Refresh the model list or choose another Go model.')
    const headers = goHeaders(params.sessionId || this.fallbackSession)
    let client: LLMProvider
    switch (protocol) {
      case 'chat': client = new OpenAICompatibleProvider(this.name, this.model, { apiKey: this.key, baseURL: `${GO_BASE}/openai/v1`, maxTokensField: 'max_tokens', defaultHeaders: headers }); break
      case 'responses': client = new ResponsesProvider(this.key, this.model, `${GO_BASE}/openai/v1`, headers); break
      case 'anthropic': client = new AnthropicProvider(this.key, this.model, `${GO_BASE}/anthropic`, { defaultHeaders: headers }); break
      case 'google': client = new GoogleProvider(this.key, this.model, { baseUrl: `${GO_BASE}/google`, headers }); break
    }
    try { yield* client.chat(params) }
    catch (error) { throw openCodeAccessError(error) }
  }
}
