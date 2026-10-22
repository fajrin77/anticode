import { ProviderRequestError } from '../providers/requestError'
import { shell } from 'electron'
import { makeVerifier, makeChallenge, makeState } from './pkce'
import { withRelogin } from './types'
import type { AuthLoginCallbacks, AuthTokens } from './types'

/*
 * Claude Code login. The official client runs the same flow: the browser
 * lands on a page that shows a short code, the user pastes it back, and we
 * exchange it for an account-level token. No local listener is needed.
 */

const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers'
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  account?: { uuid?: string; email_address?: string }
  organization?: { uuid?: string }
}

function toTokens(raw: TokenResponse, previous?: AuthTokens): AuthTokens {
  if (typeof raw.access_token !== 'string' || !raw.access_token.trim()) throw new Error('Claude returned no access token. Start Sign in again.')
  const refreshToken = raw.refresh_token ?? previous?.refreshToken
  const userId = raw.account?.uuid ?? previous?.meta?.userId
  const organizationId = raw.organization?.uuid ?? previous?.meta?.organizationId
  const accountId = userId ? [userId, organizationId].filter(Boolean).join('/') : previous?.meta?.accountId
  return {
    accessToken: raw.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: typeof raw.expires_in === 'number' && raw.expires_in > 0 ? Date.now() + raw.expires_in * 1000 : 0,
    meta: {
      ...previous?.meta,
      email: raw.account?.email_address ?? previous?.meta?.email ?? '',
      ...(userId ? { userId } : {}),
      ...(organizationId ? { organizationId } : {}),
      ...(accountId ? { accountId } : {}),
      ...(raw.scope ? { scope: raw.scope } : {})
    }
  }
}

/** The vendor's own wording beats "failed: 400" when a grant is refused. */
async function reason(response: Response): Promise<string> {
  try {
    const body = await response.text()
    const parsed = JSON.parse(body) as { error_description?: string; error?: string }
    return (parsed.error_description ?? parsed.error ?? body).slice(0, 200)
  } catch {
    return `HTTP ${response.status}`
  }
}

/** Accepts either the bare code or the whole `code#state` string. */
function parsePasted(input: string): { code: string; state: string } {
  const trimmed = input.trim()
  // A callback URL may itself contain a fragment. Parse the URL before the
  // short code#state format so the full URL is never exchanged as a code.
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed)
    return { code: url.searchParams.get('code') ?? '', state: url.searchParams.get('state') ?? '' }
  }
  const hash = trimmed.indexOf('#')
  if (hash >= 0) return { code: trimmed.slice(0, hash), state: trimmed.slice(hash + 1) }
  return { code: trimmed, state: '' }
}

export async function loginClaude(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const verifier = makeVerifier()
  const challenge = makeChallenge(verifier)
  const state = makeState()

  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)

  callbacks.onUpdate({
    message: 'Sign in to Claude, then paste the complete code#state into Anticode',
    url: url.toString(),
    needsCode: true
  })
  void shell.openExternal(url.toString())

  const pasted = await callbacks.promptForCode('Paste the complete Claude code#state or callback URL:')
  const parsed = parsePasted(pasted)
  callbacks.signal.throwIfAborted()
  if (parsed.code === '') throw new Error('No code was pasted')
  if (parsed.state && parsed.state !== state) throw new Error('This Claude code belongs to another Sign in attempt. Start Sign in from Anticode and paste the new code#state here.')

  callbacks.onUpdate({ message: 'Exchanging the code…' })
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    signal: AbortSignal.any([callbacks.signal, AbortSignal.timeout(15_000)]),
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: parsed.code,
      state,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier
    })
  })
  if (!response.ok) throw new Error(`Claude token exchange failed: ${await reason(response)}`)
  const tokens = toTokens((await response.json()) as TokenResponse)
  callbacks.onUpdate({ message: 'Signed in', done: true })
  return tokens
}

export async function refreshClaude(tokens: AuthTokens): Promise<AuthTokens> {
  if (tokens.refreshToken === undefined) throw new Error('No refresh token')
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: CLIENT_ID
    })
  })
  if (!response.ok) {
    const detail = await reason(response)
    if (response.status === 401 || response.status === 400) {
      throw new ProviderRequestError(withRelogin(`Claude refresh failed: ${detail}.`), response.status, 'account')
    }
    throw new ProviderRequestError(`Claude refresh failed: ${detail}`, response.status, 'account')
  }
  return toTokens((await response.json()) as TokenResponse, tokens)
}

export function accountLabel(tokens: AuthTokens): string | undefined {
  return tokens.meta?.email || undefined
}