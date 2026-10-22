import { ProviderRequestError } from '../providers/requestError'
import { shell } from 'electron'
import { makeState } from './pkce'
import { waitForCallback } from './server'
import { withRelogin } from './types'
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
  expiresAt?: string | number
  email?: string
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
  const expiresAt = typeof data.expiresAt === 'number'
    ? (data.expiresAt < 1e12 ? data.expiresAt * 1000 : data.expiresAt)
    : data.expiresAt !== undefined ? Date.parse(data.expiresAt) : NaN
  return {
    accessToken,
    refreshToken,
    expiresAt: Number.isNaN(expiresAt) ? 0 : expiresAt,
    meta: { ...previous?.meta, email: data.userInfo?.email ?? data.email ?? previous?.meta?.email ?? '' }
  }
}

/** Some Cline browser callbacks carry an encoded token bundle instead of an exchange code. */
export function decodeClineCallback(code: string): AuthTokens | null {
  if (!/^[A-Za-z0-9_+/-]+={0,2}$/.test(code)) return null
  try {
    const raw: unknown = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'))
    if (raw === null || typeof raw !== 'object') return null
    const data = raw as TokenData
    if (typeof data.accessToken !== 'string' || !data.accessToken || typeof data.refreshToken !== 'string' || !data.refreshToken) return null
    if (data.email !== undefined && typeof data.email !== 'string') return null
    return toTokens(data)
  } catch { return null }
}

export async function loginCline(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const state = makeState()
  // Cline does not consistently echo OAuth state. Bind the flow to an unguessable
  // callback path instead; an unrelated request cannot finish this login.
  const callbackPath = `${CALLBACK_PATH}/${state}`
  // The authorize page lives on the API host (app.cline.bot 404s); the
  // exchange repeats the redirect URI the browser was sent to.
  let callbackUrl = ''
  const callback = waitForCallback({
    ports: Array.from({ length: 11 }, (_, i) => 48801 + i),
    path: callbackPath,
    signal: callbacks.signal,
    onListening: (port) => {
      callbackUrl = `http://127.0.0.1:${port}${callbackPath}`
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
  if (result.state !== '' && result.state !== state) throw new Error('Login returned the wrong state')
  if (result.code === '') throw new Error('Login did not return a code')

  const embedded = decodeClineCallback(result.code)
  if (embedded !== null) {
    callbacks.onUpdate({ message: 'Signed in', done: true })
    return embedded
  }

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
    signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: tokens.refreshToken, grantType: 'refresh_token' })
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 400) {
      throw new ProviderRequestError(withRelogin(`Cline refresh failed: HTTP ${response.status}.`), response.status, 'account')
    }
    throw new ProviderRequestError(`Cline refresh failed: ${response.status}`, response.status, 'account')
  }
  const payload = (await response.json()) as TokenResponse
  if (!payload.success || payload.data === undefined) {
    throw new Error('Cline refresh returned no tokens')
  }
  return toTokens(payload.data, tokens)
}

export function accountLabel(tokens: AuthTokens): string | undefined {
  return tokens.meta?.email || undefined
}