import { shell } from 'electron'
import { makeState } from './pkce'
import { waitForCallback } from './server'
import type { AuthLoginCallbacks, AuthTokens } from './types'

/*
 * Cline login. The Cline app talks to WorkOS for the account and to
 * api.cline.bot for the chat. We mirror the SDK flow: an authorize URL with
 * a localhost callback, then a token exchange at api.cline.bot. The chat
 * endpoint itself is api.cline.bot/v1/chat/completions with a Bearer token.
 */

const APP_BASE = 'https://app.cline.bot'
const API_BASE = 'https://api.cline.bot'
const WORKOS_BASE = 'https://api.workos.com'
const WORKOS_CLIENT_ID = 'client_01K6XQAY7JK6T5HXVSZW2S5VYK'
const CALLBACK_PATH = '/auth'

interface WorkosTokens {
  access_token: string
  refresh_token?: string
  token_type?: string
}

async function exchangeWorkos(
  code: string,
  callbackUrl: string,
  signal: AbortSignal
): Promise<WorkosTokens> {
  const response = await fetch(`${WORKOS_BASE}/user_management/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: WORKOS_CLIENT_ID,
      redirect_uri: callbackUrl
    })
  })
  if (!response.ok) throw new Error(`WorkOS token exchange failed: ${response.status}`)
  const payload = (await response.json()) as WorkosTokens
  if (payload.access_token === undefined) throw new Error('WorkOS returned no access token')
  return payload
}

/** Trades the WorkOS access token for a Cline session token. */
async function exchangeCline(workos: WorkosTokens, signal: AbortSignal): Promise<AuthTokens> {
  const response = await fetch(`${API_BASE}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: workos.access_token,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token'
    })
  })
  if (!response.ok) throw new Error(`Cline token exchange failed: ${response.status}`)
  const payload = (await response.json()) as { accessToken?: string; refreshToken?: string }
  const refreshToken = payload.refreshToken ?? workos.refresh_token
  return {
    accessToken: payload.accessToken ?? workos.access_token,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    expiresAt: 0
  }
}

export async function loginCline(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const state = makeState()
  // WorkOS checks that the exchange repeats the redirect URI the browser was
  // sent to, so the callback the listener actually bound is what is sent.
  let callbackUrl = ''
  const callback = waitForCallback({
    ports: Array.from({ length: 11 }, (_, i) => 48801 + i),
    path: CALLBACK_PATH,
    signal: callbacks.signal,
    onListening: (port) => {
      callbackUrl = `http://127.0.0.1:${port}${CALLBACK_PATH}`
      const url = new URL('/api/v1/auth/authorize', APP_BASE)
      url.searchParams.set('client_type', 'extension')
      url.searchParams.set('callback_url', callbackUrl)
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
  const workos = await exchangeWorkos(result.code, callbackUrl, callbacks.signal)
  const tokens = await exchangeCline(workos, callbacks.signal)
  callbacks.onUpdate({ message: 'Signed in', done: true })
  return tokens
}

export async function refreshCline(tokens: AuthTokens): Promise<AuthTokens> {
  if (tokens.refreshToken === undefined) throw new Error('No refresh token')
  const response = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: tokens.refreshToken })
  })
  if (!response.ok) throw new Error(`Cline refresh failed: ${response.status}`)
  const payload = (await response.json()) as { accessToken?: string; access_token?: string }
  return {
    ...tokens,
    accessToken: payload.accessToken ?? payload.access_token ?? tokens.accessToken
  }
}

export function accountLabel(_tokens: AuthTokens): string | undefined {
  return undefined
}