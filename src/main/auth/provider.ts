import { readAuthTokens, updateAuthTokens, getAuthAccount } from './store'
import { refreshCodex } from './codex'
import { refreshClaude } from './claude'
import { refreshCline } from './cline'
import type { AuthKind, AuthTokens } from './types'
import type { LLMProvider, ChatParams, ProviderEvent } from '../providers/types'
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
 * What each plan can actually run. An account is not an API key: the vendor
 * decides the catalogue, and none of these endpoints answer a /models call
 * with a token instead of a key, so the list is written down here. The first
 * entry is what a session starts on.
 */
export const AUTH_MODELS: Record<AuthKind, readonly [string, ...string[]]> = {
  codex: ['gpt-5-codex', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5'],
  claude: [
    'claude-sonnet-4-5',
    'claude-opus-4-5',
    'claude-haiku-4-5',
    'claude-opus-4-1',
    'claude-3-5-haiku-latest'
  ],
  cline: ['claude-sonnet-4-5', 'claude-opus-4-5', 'gpt-5-codex', 'gemini-2.5-pro'],
  codebuddy: ['auto-chat', 'claude-sonnet-4.5', 'gpt-5']
}

/** Every model the vendor starts on when the user has not picked one. */
export const AUTH_DEFAULT_MODELS: Record<AuthKind, string> = {
  codex: AUTH_MODELS.codex[0],
  claude: AUTH_MODELS.claude[0],
  cline: AUTH_MODELS.cline[0],
  codebuddy: AUTH_MODELS.codebuddy[0]
}

function isStale(tokens: AuthTokens): boolean {
  return tokens.expiresAt !== undefined && tokens.expiresAt !== 0 && tokens.expiresAt - Date.now() < REFRESH_AHEAD_MS
}

async function refresh(kind: AuthKind, tokens: AuthTokens): Promise<AuthTokens> {
  switch (kind) {
    case 'codex':
      return refreshCodex(tokens)
    case 'claude':
      return refreshClaude(tokens)
    case 'cline':
      return refreshCline(tokens)
    case 'codebuddy':
      return tokens
  }
}

/**
 * The live access token for an account, renewed when it is about to die.
 *
 * `force` is the 401 path: the token we hold was rejected, so the old one is
 * known bad and a failed renewal has to surface as the error the user sees.
 * On the ordinary path a failed renewal is swallowed — the token in hand may
 * still have minutes left on it, and one flaky network call should not end a
 * conversation.
 */
async function ensureFresh(id: string, kind: AuthKind, force = false): Promise<AuthTokens> {
  const tokens = readAuthTokens(id)
  if (tokens === null) {
    throw new Error(
      `The account ${id} could not be read — sign in again in Settings → Auth provider`
    )
  }
  if (!force && !isStale(tokens)) return tokens
  if (tokens.refreshToken === undefined) {
    if (!force) return tokens
    throw new Error(
      `${AUTH_KIND_NAMES[kind]} turned the account token down and it cannot be renewed — ` +
        'sign in again in Settings → Auth provider'
    )
  }
  try {
    const next = await refresh(kind, tokens)
    updateAuthTokens(id, next)
    return next
  } catch (error) {
    if (force) throw error
    // A failed refresh is not fatal — the old token may still work.
    return tokens
  }
}

/** Only used inside error text, so it stays here rather than in the UI layer. */
const AUTH_KIND_NAMES: Record<AuthKind, string> = {
  codex: 'ChatGPT',
  claude: 'Claude',
  cline: 'Cline',
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
    this.model = model
    this.name = kind
  }

  private async client(force = false): Promise<LLMProvider> {
    const tokens = await ensureFresh(this.id, this.kind, force)
    const account = getAuthAccount(this.id)
    if (account === undefined) throw new Error(`The account ${this.id} is gone`)
    const model = this.model === '' ? AUTH_DEFAULT_MODELS[this.kind] : this.model

    switch (this.kind) {
      case 'codex':
        // The Codex backend wants the numeric ChatGPT account id from the id
        // token — `account.account` is the email, which it does not accept.
        return new CodexProvider(tokens.accessToken, model, tokens.meta?.accountId)
      case 'claude':
        return new AnthropicProvider('', model, undefined, {
          authToken: tokens.accessToken,
          defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' }
        })
      case 'cline':
        return new OpenAICompatibleProvider('cline', model, {
          apiKey: tokens.accessToken,
          baseURL: 'https://api.cline.bot/v1',
          maxTokensField: 'max_tokens'
        })
      case 'codebuddy':
        return new OpenAICompatibleProvider('codebuddy', model, {
          apiKey: tokens.accessToken,
          baseURL: 'https://www.codebuddy.ai/v2',
          maxTokensField: 'max_tokens',
          defaultHeaders: {
            'X-Domain': 'www.codebuddy.ai',
            'X-Product': 'SaaS',
            'User-Agent': 'CLI/1.0.8 CodeBuddy/1.0.8'
          }
        })
    }
  }

  async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
    let client = await this.client()
    let produced = false
    try {
      for await (const event of client.chat(params)) {
        produced = true
        yield event
      }
      return
    } catch (error) {
      // Only a turn that said nothing yet can be replayed; re-running one
      // that already streamed half an answer would duplicate it.
      if (produced || !isExpiredToken(error)) throw error
    }
    // A 401 after a mid-conversation expiry: renew and try exactly once.
    client = await this.client(true)
    for await (const event of client.chat(params)) yield event
  }
}

/**
 * Whether the vendor turned the account token down. Each of the four says it
 * differently — a bare 401, an `invalid_token` body, or the word itself — so
 * all three shapes count.
 */
function isExpiredToken(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    message.includes('401') ||
    message.includes('invalid_token') ||
    message.includes('unauthorized') ||
    message.includes('token expired')
  )
}

/** True when the id belongs to an OAuth account, e.g. `auth:codex`. */
export function isAuthProvider(id: string): boolean {
  return id.startsWith('auth:')
}

/** Builds an account-backed provider for a session. */
export function authProvider(id: string, model: string): LLMProvider {
  const account = getAuthAccount(id)
  if (account === undefined) {
    throw new Error('This OAuth account is gone — sign in again in Settings → Auth provider')
  }
  return new AuthProvider(id, account.kind, model)
}
