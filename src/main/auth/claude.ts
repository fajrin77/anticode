import { shell } from 'electron'
import { makeVerifier, makeChallenge, makeState } from './pkce'
import type { AuthLoginCallbacks, AuthTokens } from './types'

/*
 * Claude Code login. The official client runs the same flow: the browser
 * lands on a page that shows a short code, the user pastes it back, and we
 * exchange it for an account-level token. No local listener is needed.
 */

const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers'
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  account?: { email_address?: string }
}

function toTokens(raw: TokenResponse, previous?: AuthTokens): AuthTokens {
  const refreshToken = raw.refresh_token ?? previous?.refreshToken
  return {
    accessToken: raw.access_token,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    expiresAt: raw.expires_in ? Date.now() + raw.expires_in * 1000 : 0,
    meta: { email: raw.account?.email_address ?? previous?.meta?.email ?? '' }
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
  const hash = trimmed.indexOf('#')
  if (hash >= 0) return { code: trimmed.slice(0, hash), state: trimmed.slice(hash + 1) }
  const url = (() => {
    try {
      return new URL(trimmed)
    } catch {
      return null
    }
  })()
  if (url !== null) {
    return {
      code: url.searchParams.get('code') ?? '',
      state: url.searchParams.get('state') ?? ''
    }
  }
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
    message: 'Sign in to Claude, then paste the code shown back here',
    url: url.toString(),
    needsCode: true
  })
  void shell.openExternal(url.toString())

  const pasted = await callbacks.promptForCode('Paste the Claude authorization code:')
  const parsed = parsePasted(pasted)
  if (parsed.code === '') throw new Error('No code was pasted')

  callbacks.onUpdate({ message: 'Exchanging the code…' })
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: callbacks.signal,
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: parsed.code,
      state: parsed.state === '' ? state : parsed.state,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier
    })
  })
  if (!response.ok) throw new Error(`Claude token exchange failed — ${await reason(response)}`)
  const tokens = toTokens((await response.json()) as TokenResponse)
  callbacks.onUpdate({ message: 'Signed in', done: true })
  return tokens
}

export async function refreshClaude(tokens: AuthTokens): Promise<AuthTokens> {
  if (tokens.refreshToken === undefined) throw new Error('No refresh token')
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: CLIENT_ID
    })
  })
  if (!response.ok) throw new Error(`Claude refresh failed — ${await reason(response)}`)
  return toTokens((await response.json()) as TokenResponse, tokens)
}

export function accountLabel(tokens: AuthTokens): string | undefined {
  return tokens.meta?.email || undefined
}