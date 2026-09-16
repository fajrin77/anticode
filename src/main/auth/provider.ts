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
/** Every model the vendor starts on when the user has not picked one. */
export const AUTH_DEFAULT_MODELS: Record<AuthKind, string> = {
  codex: 'gpt-5-codex',
  claude: 'claude-sonnet-4-5',
  cline: 'claude-sonnet-4-5',
  codebuddy: 'auto-chat'
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

async function ensureFresh(id: string, kind: AuthKind, force = false): Promise<AuthTokens> {
  const tokens = readAuthTokens(id)
  if (tokens === null) throw new Error(`The account ${id} is gone — sign in again in Settings → Auth provider`)
  if (!force && (!isStale(tokens) || tokens.refreshToken === undefined)) return tokens
  if (tokens.refreshToken === undefined) return tokens
  try {
    const next = await refresh(kind, tokens)
    updateAuthTokens(id, next)
    return next
  } catch {
    // A failed refresh is not fatal — the old token may still work.
    return tokens
  }
}

const forceFresh = ensureFresh

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
    const tokens = force ? await forceFresh(this.id, this.kind) : await ensureFresh(this.id, this.kind)
    const account = getAuthAccount(this.id)
    if (account === undefined) throw new Error(`The account ${this.id} is gone`)
    const model = this.model === '' ? AUTH_DEFAULT_MODELS[this.kind] : this.model

    switch (this.kind) {
      case 'codex': {
        // Codex's account endpoint wants the numeric ChatGPT account id
        // alongside the bearer token when one is on file.
        const accountId = account.account ?? tokens.meta?.accountId
        return new CodexProvider(tokens.accessToken, model, accountId)
      }
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
            'User-Agent': 'CLI/1.0.7 CodeBuddy/1.0.7'
          }
        })
    }
  }

  async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
    let client = await this.client()
    try {
      for await (const event of client.chat(params)) yield event
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A 401 after a mid-conversation expiry: refresh and try exactly once.
      if (!message.includes('401')) throw error
      client = await this.client(true)
      for await (const event of client.chat(params)) yield event
    }
  }
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
