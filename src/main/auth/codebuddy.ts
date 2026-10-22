import { ProviderRequestError } from '../providers/requestError'
import { APP_VERSION } from '../version'
import { shell } from 'electron'
import { makeState } from './pkce'
import type { AuthLoginCallbacks, AuthTokens } from './types'

/*
 * CodeBuddy (Tencent) login. The CLI starts a session at
 * www.codebuddy.ai/v2/plugin/auth/state, opens the returned authUrl, then
 * polls www.codebuddy.ai/v2/plugin/auth/token until the login is complete.
 * The chat side then speaks OpenAI's wire format at /v2/chat/completions
 * with a Bearer token plus the X-Domain/User-Agent headers the CLI sends.
 */

const BASE = 'https://www.codebuddy.ai'
const STATE_URL = `${BASE}/v2/plugin/auth/state?platform=CLI`
const TOKEN_URL = `${BASE}/v2/plugin/auth/token`
const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 5 * 60 * 1000

function headers(requestId: string): Record<string, string> {
  return {
    Host: 'www.codebuddy.ai',
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Connection: 'close',
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
    'User-Agent': `anticode/${APP_VERSION}`,
    'X-Product': 'SaaS',
    'X-Request-ID': requestId
  }
}

interface StateResponse {
  code?: number
  data?: { state?: string; authUrl?: string }
}

interface TokenResponse {
  code?: number
  data?: {
    state?: string
    accessToken?: string
    bearerToken?: string
    refreshToken?: string
    expiresIn?: number
    expiresAt?: number
    user_id?: string
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const onAbort = (): void => { clearTimeout(timer); reject(new Error('Login cancelled')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** CodeBuddy responses may use epoch seconds or milliseconds. */
function tokenExpiry(expiresAt: number | undefined, expiresIn: number | undefined): number {
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0) return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt
  return typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0
}

export async function loginCodebuddy(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const signal = callbacks.signal
  const requestId = makeState()

  const start = await fetch(STATE_URL, {
    method: 'POST',
    headers: headers(requestId),
    body: JSON.stringify({}),
    signal
  })
  if (!start.ok) throw new Error(`CodeBuddy login could not start: ${start.status}`)
  const started = (await start.json()) as StateResponse
  const state = started.data?.state ?? ''
  const authUrl = started.data?.authUrl ?? ''
  if (state === '' || authUrl === '') throw new Error('CodeBuddy returned no login URL')

  callbacks.onUpdate({ message: 'Sign in to CodeBuddy in the browser', url: authUrl })
  void shell.openExternal(authUrl)

  const deadline = Date.now() + POLL_TIMEOUT_MS
  let waited = 0
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS, signal)
    waited += POLL_INTERVAL_MS
    const poll = await fetch(`${TOKEN_URL}?${new URLSearchParams({ state })}`, {
      method: 'GET',
      headers: headers(makeState()),
      signal
    })
    if (poll.status === 401 || poll.status === 403) throw new Error(`CodeBuddy refused login (HTTP ${poll.status}). Start sign in again.`)
    if (!poll.ok) continue
    const payload = (await poll.json()) as TokenResponse
    const token = payload.data?.accessToken ?? payload.data?.bearerToken
    if ((payload.code === undefined || payload.code === 0 || payload.code === 200) && token !== undefined && token !== '') {
      if (payload.data?.state && payload.data.state !== state) throw new Error('CodeBuddy login returned the wrong state')
      const identity = await fetch(`${BASE}/v2/plugin/account`, { headers: { Authorization: `Bearer ${token}`, 'X-Domain': 'www.codebuddy.ai', 'User-Agent': `anticode/${APP_VERSION}` }, signal }).then(async response => response.ok ? (await response.json() as {data?: {uid?: string; email?: string; nickname?: string}}).data : undefined).catch(error => { if (signal.aborted) throw error; return undefined })
      callbacks.onUpdate({ message: 'Signed in', done: true })
      const refreshToken = payload.data?.refreshToken
      return {
        accessToken: token,
        ...(refreshToken !== undefined ? { refreshToken } : {}),
        expiresAt: tokenExpiry(payload.data?.expiresAt, payload.data?.expiresIn),
        meta: {
          userId: identity?.uid ?? payload.data?.user_id ?? '',
          ...(identity?.email ? { email: identity.email } : {}),
          sessionState: payload.data?.state ?? ''
        }
      }
    }
    // Five minutes of silence looks like a hang otherwise; say what is being
    // waited on once the browser has had a moment to load.
    if (waited === POLL_INTERVAL_MS * 4) {
      callbacks.onUpdate({ message: 'Waiting for you to finish signing in', url: authUrl })
    }
  }
  throw new Error('CodeBuddy login timed out')
}

export function accountLabel(tokens: AuthTokens): string | undefined {
  return tokens.meta?.email || tokens.meta?.userId || undefined
}

/** Refresh grant observed in the official CodeBuddy CLI 2.171.0. */
export async function refreshCodebuddy(tokens: AuthTokens): Promise<AuthTokens> {
  if (!tokens.refreshToken) throw new Error('CodeBuddy has no refresh token. Sign in again in Settings → Auth provider.')
  const response = await fetch(`${BASE}/v2/plugin/auth/token/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      authorization: `Bearer ${tokens.accessToken}`, 'X-Refresh-Token': tokens.refreshToken,
      'X-Auth-Refresh-Source': 'plugin', 'X-Domain': 'www.codebuddy.ai', 'User-Agent': `anticode/${APP_VERSION}` },
    body: '{}', signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) throw new ProviderRequestError(`CodeBuddy token renewal failed (HTTP ${response.status}).${response.status === 400 || response.status === 401 ? ' Sign in again.' : ' Try again shortly.'}`, response.status, 'account')
  const payload = await response.json() as { data?: { accessToken?: string; refreshToken?: string; expiresIn?: number; expiresAt?: number } }
  if (!payload.data?.accessToken) throw new Error('CodeBuddy returned no renewed token. Sign in again.')
  return { ...tokens, accessToken: payload.data.accessToken, refreshToken: payload.data.refreshToken || tokens.refreshToken,
    expiresAt: tokenExpiry(payload.data.expiresAt, payload.data.expiresIn) }
}
