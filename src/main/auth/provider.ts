import { CLINEPASS_MODELS } from '../providers/clinepass'
import { randomUUID } from 'node:crypto'
import { presetAllowsModel } from '@shared/providerPresets'
import { APP_VERSION } from '../version'
import { MINIMAX_PLAN_MODELS } from './minimaxPlan'
import { VERCEL_GATEWAY_BASE } from './vercel'
import { failureStatus, isTransient } from '../providers/failures'
import { ProviderRequestError } from '../providers/requestError'
import { clearLoginCooldown } from '../rotation'
import { CLINE_FREE_FALLBACK, isExplicitClineFreeModel, preferredClineFreeRoute } from '@shared/clineModels'
import { authModelsFor, clineRestriction, markClineRestricted } from './catalogue'
import { readAuthTokens, updateAuthTokens, getAuthAccount } from './store'
import { withRelogin } from './types'
import { refreshCodex } from './codex'
import { refreshClaude } from './claude'
import { checkClaudeSubscription } from './claudeAccess'
import { ClaudeCodeProvider } from '../providers/claudeCode'
import { OpenCodeGoProvider, goModels } from '../providers/opencodeGo'
import { refreshCodebuddy } from './codebuddy'
import { refreshCline } from './cline'
import type { AuthKind, AuthTokens } from './types'
import type { LLMProvider, ChatParams, ProviderEvent } from '../providers/types'
import { CLINE_API_BASE, CLINE_HEADERS, clineApiToken } from '../providers/clineConfig'
import { CodexProvider } from '../providers/codex'
import { AnthropicProvider } from '../providers/anthropic'
import { OpenAICompatibleProvider } from '../providers/openai'

/*
 * The chat side of an OAuth account. `createProvider` builds the vendor
 * client; this wrapper adds what an *account* needs that a plain API key
 * does not:
 *
 * - a fresh access token. Plan tokens are short-lived (Claude ~1h, Codex
 *   hours), so the wrapper refreshes them through the vendor's refresh
 *   grant when they are within five minutes of expiring, and stores the
 *   result back in the sealed account file. A 401 forces the same path, so
 *   a clock drift or an early expiry heals itself on the next turn.
 * - retry once on 401 with the fresh token, so a long conversation does not
 *   die in the middle because its first hour ran out.
 */

const REFRESH_AHEAD_MS = 5 * 60 * 1000

/**
 * Offline catalogue defaults. Live account catalogues augment these choices;
 * Cline OAuth is restricted to free aliases. The first entry starts new sessions.
 */
export const AUTH_MODELS: Record<AuthKind, readonly [string, ...string[]]> = {
  clinepass: CLINEPASS_MODELS as [string, ...string[]],
  'minimax-plan': MINIMAX_PLAN_MODELS,
  kilo: ['minimax/minimax-m3.1-flash:free'],
  // Only free routes; the live catalogue adds whatever else the key allows.
  vercel: ['zai/glm-4.5-air:free', 'openai/gpt-oss-20b:free'],
  openrouter: ['openrouter/free'],
  // Offline fallback only; the signed-in account catalogue takes precedence.
  codex: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
  claude: [
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-haiku-5-5',
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-haiku-4-5'
  ],
  cline: [...CLINE_FREE_FALLBACK],
  'opencode-go': goModels() as [string, ...string[]],
  codebuddy: ['default-model', 'fast-model', 'balanced-model', 'deepseek-v4.1-flash']
}

/** Every model the vendor starts on when the user has not picked one. */
export const AUTH_DEFAULT_MODELS: Record<AuthKind, string> = {
  clinepass: CLINEPASS_MODELS[0]!,
  'minimax-plan': MINIMAX_PLAN_MODELS[0],
  kilo: AUTH_MODELS.kilo[0],
  vercel: AUTH_MODELS.vercel[0],
  openrouter: AUTH_MODELS.openrouter[0],
  codex: AUTH_MODELS.codex[0],
  claude: AUTH_MODELS.claude[0],
  cline: AUTH_MODELS.cline[0],
  'opencode-go': AUTH_MODELS['opencode-go'][0],
  codebuddy: AUTH_MODELS.codebuddy[0]
}

function isStale(tokens: AuthTokens): boolean {
  return tokens.expiresAt !== undefined && tokens.expiresAt !== 0 && tokens.expiresAt - Date.now() < REFRESH_AHEAD_MS
}

async function refresh(kind: AuthKind, tokens: AuthTokens): Promise<AuthTokens> {
  switch (kind) {
    case 'minimax-plan': return tokens
    case 'kilo':
    case 'openrouter': return tokens
    case 'codex':
      return refreshCodex(tokens)
    case 'claude':
      return refreshClaude(tokens)
    case 'clinepass':
    case 'cline':
      return refreshCline(tokens)
    case 'opencode-go': return tokens
    // A gateway key is long-lived and has no renewal endpoint.
    case 'vercel': return tokens
    case 'codebuddy': return refreshCodebuddy(tokens)
  }
}

/** How long a dead login rests before routing tries that account again. */
const DEAD_LOGIN_REST_MS = 6 * 60 * 60_000

/**
 * A login the vendor refuses to renew. It carries the 401 and account scope
 * routing looks for, so another account of the same model takes the turn
 * instead of the session ending on this one's error.
 */
function deadLogin(message: string): Error {
  return Object.assign(new Error(message), { status: 401, scope: 'account', retryAt: Date.now() + DEAD_LOGIN_REST_MS })
}

/**
 * The live access token for an account, renewed when it is about to die.
 *
 * `force` is the 401 path: the token we hold was rejected, so the old one is
 * known bad and a failed renewal has to surface as the error the user sees.
 * On the ordinary path a failed renewal is swallowed, the token in hand may
 * still have minutes left on it, and one flaky network call should not end a
 * conversation.
 */
async function renewTokens(id: string, kind: AuthKind, force = false): Promise<AuthTokens> {
  const tokens = readAuthTokens(id)
  if (tokens === null) {
    throw new Error(
      `The account ${id} could not be read. Sign in again in Settings → Auth provider`
    )
  }
  if (!force && !isStale(tokens)) return tokens
  if (tokens.refreshToken === undefined) {
    if (!force) return tokens
    throw deadLogin(
      `${AUTH_KIND_NAMES[kind]} turned the account token down and it cannot be renewed. ` +
        'Sign in again in Settings → Auth provider'
    )
  }
  try {
    const next = await refresh(kind, tokens)
    updateAuthTokens(id, next)
    clearLoginCooldown(id)
    return next
  } catch (error) {
    // A refused grant on the forced path means the stored login is dead: say
    // so plainly instead of surfacing a bare HTTP status mid-conversation.
    if (force || (tokens.expiresAt !== undefined && tokens.expiresAt > 0 && tokens.expiresAt <= Date.now())) {
      if (isTransient(error)) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw deadLogin(withRelogin(message.replace(/\.*$/, '.')))
    }
    // A failed refresh is not fatal, the old token may still work.
    return tokens
  }
}

// Refresh grants can rotate their refresh token: all sessions and the Renew button
// must share one in-flight grant for each account.
const refreshing = new Map<string, Promise<AuthTokens>>()

export function ensureFreshAuthTokens(id: string, force = false): Promise<AuthTokens> {
  const pending = refreshing.get(id)
  if (pending !== undefined) return pending
  const account = getAuthAccount(id)
  if (account === undefined) return Promise.reject(new Error('That account is no longer stored.'))
  const work = renewTokens(id, account.kind, force)
  refreshing.set(id, work)
  void work.finally(() => { if (refreshing.get(id) === work) refreshing.delete(id) }).catch(() => {})
  return work
}

/** Only used inside error text, so it stays here rather than in the UI layer. */
const AUTH_KIND_NAMES: Record<AuthKind, string> = {
  'minimax-plan': 'MiniMax Token Plan',
  kilo: 'Kilo',
  vercel: 'Vercel AI Gateway',
  openrouter: 'OpenRouter',
  codex: 'ChatGPT',
  claude: 'Claude',
  cline: 'Cline Free',
  clinepass: 'ClinePass',
  'opencode-go': 'OpenCode Go',
  codebuddy: 'CodeBuddy'
}

/** Wraps a vendor client so every turn talks with a live account token. */
class AuthProvider implements LLMProvider {
  readonly name: string
  readonly id: string
  readonly model: string

  constructor(
    id: string,
    private readonly kind: AuthKind,
    model: string
  ) {
    this.id = id
    this.model = kind === 'cline' ? preferredClineFreeRoute(model, authModelsFor(id, kind)) : model
    this.name = kind
  }

  private async client(force = false, sessionId?: string, signal?: AbortSignal): Promise<LLMProvider> {
    const requested = this.model || AUTH_DEFAULT_MODELS[this.kind]
    if ((['claude', 'codex', 'codebuddy', 'opencode-go'] as AuthKind[]).includes(this.kind) && (!authModelsFor(this.id, this.kind).includes(requested) || (this.kind === 'claude' && !requested.startsWith('claude-')))) {
      throw new ProviderRequestError('The selected model is not in this account’s catalogue. Choose a supported model; saved Rotate entries do not grant model access.', 400)
    }
    if (this.kind === 'minimax-plan' && !authModelsFor(this.id, this.kind).includes(requested)) throw new ProviderRequestError('Choose a model reported by this MiniMax Token Plan. Wallet/PAYG model aliases are not substituted.', 400)
    if ((this.kind === 'kilo' || this.kind === 'openrouter') && (!presetAllowsModel(this.kind === 'kilo' ? 'kilo-free' : 'openrouter-free', requested) || !authModelsFor(this.id, this.kind).includes(requested))) {
      throw new ProviderRequestError('This browser connection uses current free model routes only. Refresh the model list or choose a free model; paid fallback is disabled.', 400)
    }
    if (this.kind === 'clinepass' && (!requested.startsWith('cline-pass/') || !authModelsFor(this.id, 'clinepass').includes(requested))) throw new ProviderRequestError('Choose a ClinePass subscription model. Usage-billing routes are disabled.', 400)
    const restriction = this.kind === 'cline' ? clineRestriction(this.id, requested) : null
    if (restriction) throw Object.assign(new Error(restriction), { status: 403 })
    if (this.kind === 'cline' && !authModelsFor(this.id, 'cline').includes(requested)) {
      if (isExplicitClineFreeModel(requested)) {
        throw new Error('This free model is no longer in the current Cline catalogue. Choose another free model in the model picker.')
      }
      throw new Error('Choose a free Cline model in the model picker. Paid models are disabled for Cline login.')
    }
    const tokens = await ensureFreshAuthTokens(this.id, force)
    const account = getAuthAccount(this.id)
    if (account === undefined) throw new Error(`The account ${this.id} is gone`)
    const model = this.model === '' ? AUTH_DEFAULT_MODELS[this.kind] : this.model

    switch (this.kind) {
      case 'minimax-plan':
        if (!/^sk-cp-\S+$/.test(tokens.accessToken)) throw new ProviderRequestError('This MiniMax connection requires a Token Plan sk-cp key. Reconnect in Auth provider.', 401, 'account')
        return new AnthropicProvider('', model, 'https://api.minimax.io/anthropic', { authToken: tokens.accessToken, defaultHeaders: { 'user-agent': `anticode/${APP_VERSION}` } })
      case 'kilo':
      case 'openrouter':
        return new OpenAICompatibleProvider(this.kind, model, { apiKey: tokens.accessToken, baseURL: this.kind === 'kilo' ? 'https://ai-gateway.kilo.ai/api/v1' : 'https://openrouter.ai/api/v1', maxTokensField: 'max_tokens', defaultHeaders: { 'user-agent': `anticode/${APP_VERSION}`, 'X-Title': 'Anticode' } })
      case 'vercel':
        return new OpenAICompatibleProvider('vercel', model, {
          apiKey: tokens.accessToken,
          baseURL: VERCEL_GATEWAY_BASE,
          maxTokensField: 'max_tokens',
          defaultHeaders: { 'user-agent': `anticode/${APP_VERSION}`, 'X-Title': 'Anticode' }
        })
      case 'codex':
        // The Codex backend wants the numeric ChatGPT account id from the id
        // token, `account.account` is the email, which it does not accept.
        return new CodexProvider(tokens.accessToken, model, tokens.meta?.accountId)
      case 'claude':
        await checkClaudeSubscription(this.id, tokens, signal)
        return new ClaudeCodeProvider(this.id, model, tokens.accessToken)
      case 'clinepass':
      case 'cline':
        return new OpenAICompatibleProvider('cline', model, {
          apiKey: clineApiToken(tokens.accessToken),
          baseURL: CLINE_API_BASE,
          maxTokensField: 'max_tokens',
          defaultHeaders: CLINE_HEADERS
        })
      case 'opencode-go': return new OpenCodeGoProvider(tokens.accessToken, model)
      case 'codebuddy':
        return new OpenAICompatibleProvider('codebuddy', model, {
          apiKey: tokens.accessToken,
          baseURL: 'https://www.codebuddy.ai/v2',
          maxTokensField: 'max_tokens',
          defaultHeaders: {
            'X-Domain': 'www.codebuddy.ai',
            'X-Product': 'SaaS',
            'User-Agent': 'anticode',
            'X-Conversation-ID': sessionId ?? randomUUID(),
            'X-Conversation-Request-ID': randomUUID(),
            'X-Conversation-Message-ID': randomUUID()
          }
        })
    }
  }

  async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
    // Before the client is built: a paid route must never reach the gateway.
    if (this.kind === 'vercel') {
      const requested = this.model || AUTH_DEFAULT_MODELS[this.kind]
      if (!presetAllowsModel('vercel-free', requested) || !authModelsFor(this.id, 'vercel').includes(requested)) {
        throw new ProviderRequestError('This gateway connection uses free model routes only. Refresh the model list or choose a model ending in :free; paid fallback is disabled.', 400)
      }
    }
    let client = await this.client(false, params.sessionId, params.signal)
    let produced = false
    try {
      for await (const event of client.chat(params)) {
        produced ||= event.type === 'response' || event.text.length > 0
        yield event
      }
      return
    } catch (error) {
      // Only a turn that said nothing yet can be replayed; re-running one
      // that already streamed half an answer would duplicate it.
      if (this.kind === 'cline' && error instanceof Error && error.message.includes('only available via Cline product surfaces')) {
        const reason = 'Cline restricts this free model to its official apps. Choose another free Cline model in Anticode.'
        markClineRestricted(this.id, this.model || AUTH_DEFAULT_MODELS.cline, reason)
        throw Object.assign(new Error(reason), { status: 403 })
      }
      if (this.kind === 'codebuddy' && isCodebuddyChannelRestriction(error)) {
        throw new ProviderRequestError('CodeBuddy menolak verifikasi kanal aplikasi (11128). Akses Anticode belum diizinkan oleh provider. Renew token tidak mengatasi pembatasan ini; gunakan klien resmi CodeBuddy atau integrasi publik yang didukung.', 403)
      }
      if (produced || !isExpiredToken(error)) throw error
    }
    // A 401 after a mid-conversation expiry: renew and try exactly once.
    client = await this.client(true, params.sessionId, params.signal)
    for await (const event of client.chat(params)) yield event
  }
}

/**
 * Whether the vendor turned the account token down. Each of the four says it
 * differently, a bare 401, an `invalid_token` body, or the word itself, so
 * all three shapes count.
 */
function isCodebuddyChannelRestriction(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { error?: { code?: unknown }; code?: unknown } | null)?.error?.code ?? (error as { code?: unknown } | null)?.code
  return String(code) === '11128' || /["']?code["']?\s*:\s*11128|failed channel verification/i.test(message)
}

function isExpiredToken(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    failureStatus(error) === 401 ||
    message.includes('401') ||
    /invalid[_ -]?token|unauthorized|token.{0,16}expir|jwt.{0,16}expir/i.test(message)
  )
}

/** True when the id belongs to an OAuth account, e.g. `auth:codex`. */
export function isAuthProvider(id: string): boolean {
  return id.startsWith('auth:') || (id === 'clinepass' && getAuthAccount(id)?.kind === 'clinepass')
}

/** Builds an account-backed provider for a session. */
export function authProvider(id: string, model: string): LLMProvider {
  const account = getAuthAccount(id)
  if (account === undefined) {
    throw new Error('This OAuth account is gone. Sign in again in Settings → Auth provider')
  }
  return new AuthProvider(id, account.kind, model)
}
