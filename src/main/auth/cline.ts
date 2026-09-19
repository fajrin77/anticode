import { shell } from 'electron'
import { makeState } from './pkce'
import { waitForCallback } from './server'
import type { AuthLoginCallbacks, AuthTokens } from './types'

/*
 * Cline login, mirroring the official extension SDK flow (sdk/packages/core/
 * src/auth/cline.ts): an authorize URL on the API host with a localhost
 * callback, then a token exchange at the same host. The chat endpoint itself
 * is api.cline.bot/v1/chat/completions with a Bearer token.
 */

const API_BASE = 'https://api.cline.bot'
const CALLBACK_PATH = '/auth'

interface TokenData {
  accessToken?: string
  access_token?: string
  refreshToken?: string
  refresh_token?: string
  tokenType?: string
  expiresAt?: string
  userInfo?: { email?: string }
}

interface TokenResponse {
  success: boolean
  data?: TokenData
}

function toTokens(data: TokenData, previous?: AuthTokens): AuthTokens {
  const accessToken = data.accessToken ?? data.access_token ?? ''
  if (accessToken === '') throw new Error('Token exchange returned no access token')
  const refreshToken = data.refreshToken ?? data.refresh_token ?? previous?.refreshToken
  if (refreshToken === undefined) throw new Error('Token exchange returned no refresh token')
  const expiresAt = data.expiresAt !== undefined ? Date.parse(data.expiresAt) : NaN
  return {
    accessToken,
    refreshToken,
    expiresAt: Number.isNaN(expiresAt) ? 0 : expiresAt,
    meta: { email: data.userInfo?.email ?? previous?.meta?.email ?? '' }
  }
}

export async function loginCline(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const state = makeState()
  // The authorize page lives on the API host (app.cline.bot 404s); the
  // exchange repeats the redirect URI the browser was sent to.
  let callbackUrl = ''
  const callback = waitForCallback({
    ports: Array.from({ length: 11 }, (_, i) => 48801 + i),
    path: CALLBACK_PATH,
    signal: callbacks.signal,
    onListening: (port) => {
      callbackUrl = `http://127.0.0.1:${port}${CALLBACK_PATH}`
      const url = new URL('/api/v1/auth/authorize', API_BASE)
      url.searchParams.set('client_type', 'extension')
      url.searchParams.set('callback_url', callbackUrl)
      url.searchParams.set('redirect_uri', callbackUrl)
      url.searchParams.set('state', state)
      callbacks.onUpdate({ message: 'Sign in to your Cline account', url: url.toString() })
      void shell.openExternal(url.toString())
    }
  })

  const result = await callback
  if (result.error !== undefined) throw new Error(result.error)
  if (result.state !== state) throw new Error('Login returned the wrong state')
  if (result.code === '') throw new Error('Login did not return a code')

  callbacks.onUpdate({ message: 'Exchanging the Cline session' })
  const response = await fetch(`${API_BASE}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: callbacks.signal,
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: result.code,
      client_type: 'extension',
      redirect_uri: callbackUrl
    })
  })
  if (!response.ok) throw new Error(`Cline token exchange failed: ${response.status}`)
  const payload = (await response.json()) as TokenResponse
  if (!payload.success || payload.data === undefined) {
    throw new Error('Cline token exchange returned no tokens')
  }
  const tokens = toTokens(payload.data)
  callbacks.onUpdate({ message: 'Signed in', done: true })
  return tokens
}

export async function refreshCline(tokens: AuthTokens): Promise<AuthTokens> {
  if (tokens.refreshToken === undefined) throw new Error('No refresh token')
  const response = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: tokens.refreshToken, grantType: 'refresh_token' })
  })
  if (!response.ok) throw new Error(`Cline refresh failed: ${response.status}`)
  const payload = (await response.json()) as TokenResponse
  if (!payload.success || payload.data === undefined) {
    throw new Error('Cline refresh returned no tokens')
  }
  return toTokens(payload.data, tokens)
}

export function accountLabel(_tokens: AuthTokens): string | undefined {
  return undefined
}