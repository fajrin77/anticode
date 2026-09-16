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
const STATE_URL = `${BASE}/v2/plugin/auth/state`
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
    Authorization: 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
    'User-Agent': 'CLI/1.0.8 CodeBuddy/1.0.8',
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
    user_id?: string
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('Login cancelled'))
      },
      { once: true }
    )
  })
}

export async function loginCodebuddy(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const signal = callbacks.signal
  const requestId = makeState()

  const start = await fetch(STATE_URL, {
    method: 'POST',
    headers: headers(requestId),
    body: JSON.stringify({ platform: 'CLI' }),
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
    const poll = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: headers(makeState()),
      body: JSON.stringify({ state, platform: 'CLI' }),
      signal
    })
    if (!poll.ok) continue
    const payload = (await poll.json()) as TokenResponse
    const token = payload.data?.accessToken ?? payload.data?.bearerToken
    if (payload.code === 0 && token !== undefined && token !== '') {
      callbacks.onUpdate({ message: 'Signed in', done: true })
      const refreshToken = payload.data?.refreshToken
      return {
        accessToken: token,
        ...(refreshToken !== undefined ? { refreshToken } : {}),
        expiresAt: payload.data?.expiresIn ? Date.now() + payload.data.expiresIn * 1000 : 0,
        meta: {
          userId: payload.data?.user_id ?? '',
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
  return tokens.meta?.userId || undefined
}