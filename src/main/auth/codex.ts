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

function emailFrom(idToken: string | undefined): string | undefined {
  if (idToken === undefined) return undefined
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString())
    return typeof payload.email === 'string' ? payload.email : undefined
  } catch {
    return undefined
  }
}

function toTokens(raw: TokenResponse, previous?: AuthTokens): AuthTokens {
  const refreshToken = raw.refresh_token ?? previous?.refreshToken
  return {
    accessToken: raw.access_token,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    expiresAt: raw.expires_in ? Date.now() + raw.expires_in * 1000 : 0,
    meta: { idToken: raw.id_token ?? previous?.meta?.idToken ?? '' }
  }
}

/** Runs the browser PKCE flow; the caller stores the returned tokens. */
export async function loginCodex(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const verifier = makeVerifier()
  const challenge = makeChallenge(verifier)
  const state = makeState()

  const controller = new AbortController()
  const callback = waitForCallback({
    ports: [REDIRECT_PORT, 1456, 1457],
    path: CALLBACK_PATH,
    signal: controller.signal,
    onListening: (port) => {
      const url = new URL(AUTHORIZE_URL)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', CLIENT_ID)
      url.searchParams.set('redirect_uri', redirectUri(port))
      url.searchParams.set('scope', SCOPES)
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('state', state)
      callbacks.onUpdate({
        message: 'Open the browser and sign in to ChatGPT',
        url: url.toString()
      })
      void shell.openExternal(url.toString())
    }
  })

  let code = ''
  let returned = ''
  try {
    const result = await callback
    if (result.error !== undefined) throw new Error(result.error)
    if (result.state !== state) throw new Error('Login returned the wrong state')
    code = result.code
    returned = result.state
  } finally {
    controller.abort()
  }
  if (code === '') throw new Error('Login did not return a code')

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: CLIENT_ID,
    code_verifier: verifier,
    state: returned
  })
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!response.ok) throw new Error(`Codex token exchange failed: ${response.status}`)
  const raw = (await response.json()) as TokenResponse
  const tokens = toTokens(raw)
  tokens.meta = { ...tokens.meta, email: emailFrom(raw.id_token) ?? '' }
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
      client_id: CLIENT_ID
    })
  })
  if (!response.ok) throw new Error(`Codex refresh failed: ${response.status}`)
  return toTokens((await response.json()) as TokenResponse, tokens)
}

export function accountLabel(tokens: AuthTokens): string | undefined {
  return tokens.meta?.email || undefined
}