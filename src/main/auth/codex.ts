import { shell } from 'electron'
import { makeVerifier, makeChallenge, makeState } from './pkce'
import { waitForCallback } from './server'
import type { AuthLoginCallbacks, AuthTokens } from './types'

/** Shared by every PKCE flow that opens a URL and waits for the callback. */
export const AUTH_PKCE_NOTE = 'browser'

/*
 * OpenAI Codex CLI login. PKCE against auth.openai.com with a fixed local
 * callback at http://localhost:1455/auth/callback, the same shape the
 * official Codex client uses. The returned tokens are account-level (a
 * ChatGPT plan), so the chat side hits the Codex backend with the access
 * token rather than an API key.
 */

const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const SCOPES = 'openid profile email offline_access'
const REDIRECT_PORT = 1455
const CALLBACK_PATH = '/auth/callback'

interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

function redirectUri(port = REDIRECT_PORT): string {
  return `http://localhost:${port}${CALLBACK_PATH}`
}

interface IdTokenClaims {
  email?: string
  'https://api.openai.com/auth'?: { chatgpt_account_id?: string; chatgpt_plan_type?: string }
}

function claims(idToken: string | undefined): IdTokenClaims {
  if (idToken === undefined || idToken === '') return {}
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString()) as IdTokenClaims
  } catch {
    return {}
  }
}

/**
 * Carries the id token's claims forward. The Codex backend wants the numeric
 * ChatGPT account id in its own header, not the email, and a refresh grant
 * does not always return a new id token, so whatever the login learned is
 * kept alongside the tokens.
 */
function toTokens(raw: TokenResponse, previous?: AuthTokens): AuthTokens {
  const refreshToken = raw.refresh_token ?? previous?.refreshToken
  const idToken = raw.id_token ?? previous?.meta?.idToken ?? ''
  const parsed = claims(idToken)
  const auth = parsed['https://api.openai.com/auth']
  return {
    accessToken: raw.access_token,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    expiresAt: raw.expires_in ? Date.now() + raw.expires_in * 1000 : 0,
    meta: {
      idToken,
      email: parsed.email ?? previous?.meta?.email ?? '',
      accountId: auth?.chatgpt_account_id ?? previous?.meta?.accountId ?? '',
      plan: auth?.chatgpt_plan_type ?? previous?.meta?.plan ?? ''
    }
  }
}

/** The vendor's own wording beats "failed: 400" when a grant is refused. */
async function reason(response: Response): Promise<string> {
  try {
    const body = await response.text()
    const parsed = JSON.parse(body) as { error_description?: string; error?: string }
    const detail = parsed.error_description ?? parsed.error ?? body
    return detail.slice(0, 200)
  } catch {
    return `HTTP ${response.status}`
  }
}

/** Runs the browser PKCE flow; the caller stores the returned tokens. */
export async function loginCodex(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const verifier = makeVerifier()
  const challenge = makeChallenge(verifier)
  const state = makeState()

  // The exchange has to repeat the exact redirect_uri the authorize URL
  // carried, so the port the listener actually bound is remembered here.
  let boundPort = REDIRECT_PORT
  const callback = waitForCallback({
    ports: [REDIRECT_PORT, 1456, 1457],
    path: CALLBACK_PATH,
    signal: callbacks.signal,
    onListening: (port) => {
      boundPort = port
      const url = new URL(AUTHORIZE_URL)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', CLIENT_ID)
      url.searchParams.set('redirect_uri', redirectUri(port))
      url.searchParams.set('scope', SCOPES)
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('state', state)
      // The official client sends these; entitlements follow them.
      url.searchParams.set('id_token_add_organizations', 'true')
      url.searchParams.set('codex_cli_simplified_flow', 'true')
      url.searchParams.set('originator', 'codex_cli_rs')
      callbacks.onUpdate({
        message: 'Open the browser and sign in to ChatGPT',
        url: url.toString()
      })
      void shell.openExternal(url.toString())
    }
  })

  const result = await callback
  if (result.error !== undefined) throw new Error(result.error)
  if (result.state !== state) throw new Error('Login returned the wrong state')
  if (result.code === '') throw new Error('Login did not return a code')

  callbacks.onUpdate({ message: 'Exchanging the ChatGPT token' })
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    signal: callbacks.signal,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: result.code,
      redirect_uri: redirectUri(boundPort),
      client_id: CLIENT_ID,
      code_verifier: verifier,
      state: result.state
    })
  })
  if (!response.ok) throw new Error(`ChatGPT token exchange failed: ${await reason(response)}`)
  const tokens = toTokens((await response.json()) as TokenResponse)
  callbacks.onUpdate({ message: 'Signed in', done: true })
  return tokens
}

/** Swaps the refresh token for a fresh access token. */
export async function refreshCodex(tokens: AuthTokens): Promise<AuthTokens> {
  if (tokens.refreshToken === undefined) throw new Error('No refresh token')
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPES
    })
  })
  if (!response.ok) throw new Error(`ChatGPT refresh failed: ${await reason(response)}`)
  return toTokens((await response.json()) as TokenResponse, tokens)
}

export function accountLabel(tokens: AuthTokens): string | undefined {
  return tokens.meta?.email || undefined
}

/** The numeric ChatGPT account id the Codex backend wants in its header. */
export function chatgptAccountId(tokens: AuthTokens): string | undefined {
  return tokens.meta?.accountId || undefined
}