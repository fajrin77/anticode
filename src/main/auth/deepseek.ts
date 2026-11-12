import { shell } from 'electron'
import { arch, platform, release } from 'node:os'
import { randomUUID } from 'node:crypto'
import { APP_VERSION } from '../version'
import { ProviderRequestError } from '../providers/requestError'
import { failureStatus, isTransient } from '../providers/failures'
import { makeChallenge, makeState, makeVerifier } from './pkce'
import { waitForCallback } from './server'
import type { AuthLoginCallbacks, AuthTokens } from './types'

/*
 * DeepSeek account login, the browser PKCE flow the DeepSeek Harness desktop
 * app uses (see docs/research/deepseek-harness-auth.md). The grant is sent as
 * `x-dsh-auth-token` to the Platform account API and to the Anthropic-format
 * Messages API. Anticode identifies itself as anticode; it does not copy the
 * Harness client identity.
 *
 * Free credit only: inference is refused unless the account holds granted
 * (bonus) credit and every top-up wallet is empty, so a request can never be
 * charged to paid balance.
 */

export const DEEPSEEK_PLATFORM = 'https://platform.deepseek.com'
export const DEEPSEEK_MESSAGES_BASE = 'https://api.deepseek.com/anthropic'
export const DEEPSEEK_TOKEN_HEADER = 'x-dsh-auth-token'
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const

function clientHeaders(): Record<string, string> {
  return {
    'user-agent': `anticode/${APP_VERSION}`,
    'x-client-platform': platform() === 'win32' ? 'desktop-win' : 'desktop-mac',
    'x-client-version': APP_VERSION,
    'x-client-locale': 'en-US',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60)
  }
}

/** Unwraps Platform's `{ code: 0, data: { biz_code: 0, biz_data } }` envelope. */
export function platformData(payload: unknown): unknown {
  const body = payload as { code?: unknown; data?: { biz_code?: unknown; biz_data?: unknown } } | null
  if (body?.code === 40003) throw new ProviderRequestError('The DeepSeek login has expired. Sign in again in Settings → Auth provider.', 401, 'account')
  if (body?.code !== 0 || body.data?.biz_code !== 0) throw new Error(`DeepSeek Platform refused the request (code ${String(body?.code)}/${String(body?.data?.biz_code)})`)
  return body.data.biz_data
}

/**
 * A reply that is not JSON must say so in words a person can act on. A bare
 * `JSON.parse` failure reads "Unexpected end of JSON input" and hides which
 * step of the sign-in the Platform refused.
 */
export function platformPayload(path: string, status: number, text: string): unknown {
  const stage = path.replace(/^\/[a-z-]+\/v0\/(?:dsh\/)?/, '')
  if (text.trim() === '') {
    throw new ProviderRequestError(
      `DeepSeek Platform sent an empty reply to ${stage} (HTTP ${status}). ` +
        (stage.startsWith('auth_')
          ? 'No account was connected. Try again; if it repeats, sign out of platform.deepseek.com in the browser and use that window for the account you want to add.'
          : 'The turn was not sent, so nothing was spent. Retry in a moment; if it repeats, the Platform is throttling this client.'),
      status
    )
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new ProviderRequestError(`DeepSeek Platform sent an unreadable reply to ${stage} (HTTP ${status}).`, status)
  }
}

/** The Platform edge answers 202 with no body while it throttles a client; one retry usually passes. */
function throttled(status: number, text: string): boolean {
  return status === 202 || text.trim() === ''
}

async function platformRequest(path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  let last = { status: 0, text: '' }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 600))
    const response = await fetch(`${DEEPSEEK_PLATFORM}${path}`, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
    if (response.status === 401) throw new ProviderRequestError('The DeepSeek login has expired. Sign in again in Settings → Auth provider.', 401, 'account')
    const text = await response.text()
    if (!response.ok) throw new ProviderRequestError(`DeepSeek Platform answered HTTP ${response.status}`, response.status)
    if (!throttled(response.status, text)) return platformData(platformPayload(path, response.status, text))
    last = { status: response.status, text }
  }
  return platformData(platformPayload(path, last.status, last.text))
}

/** Only Platform pages on the fixed path may be opened in the browser. */
export function platformPage(value: unknown, path: string): string {
  const url = new URL(String(value))
  if (url.origin !== DEEPSEEK_PLATFORM || url.pathname !== path || url.username || url.password || url.hash) throw new Error('DeepSeek returned an unexpected login page')
  return url.href
}

/**
 * The Platform registers one device per install (the vendor app keeps a single
 * device record and reuses it), so later sign-ins reuse the stored id instead of
 * looking like a brand new machine each time.
 */
export async function loginDeepSeek(callbacks: AuthLoginCallbacks, deviceId: string = randomUUID()): Promise<AuthTokens> {
  const { signal } = callbacks
  const verifier = makeVerifier()
  const state = makeState()
  let onPort: (port: number) => void = () => {}
  const port = new Promise<number>((resolve) => { onPort = resolve })
  const callback = waitForCallback({ ports: [0], path: '/oauth/callback', signal, onListening: (bound) => onPort(bound) })
  callback.catch(() => {})
  const redirectUri = `http://127.0.0.1:${await Promise.race([port, callback.then(() => 0)])}/oauth/callback`

  callbacks.onUpdate({ message: 'Starting DeepSeek sign-in' })
  const init = await platformRequest('/auth-api/v0/dsh/auth_init', {
    method: 'POST',
    headers: { ...clientHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ code_challenge: makeChallenge(verifier), code_challenge_method: 'S256', state, redirect_uri: redirectUri, locale: 'en_US', login_source: 'desktop' })
  }, signal) as { authorize_url?: unknown }
  const authorizeUrl = platformPage(init?.authorize_url, '/dsh/authorize')
  callbacks.onUpdate({ message: 'Sign in to DeepSeek in the browser', url: authorizeUrl })
  void shell.openExternal(authorizeUrl)

  const result = await callback
  if (result.error !== undefined) throw new Error(result.error)
  if (result.state !== state) throw new Error('Login returned the wrong state')
  if (result.code === '') throw new Error('Login did not return a code')

  callbacks.onUpdate({ message: 'Exchanging the DeepSeek session' })
  const exchanged = await platformRequest('/auth-api/v0/dsh/auth_exchange', {
    method: 'POST',
    headers: { ...clientHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ code: result.code, code_verifier: verifier, redirect_uri: redirectUri, device_id: deviceId, device_model: `${platform()}-${arch()}`, os_version: release() })
  }, signal) as { token?: unknown; user?: { id?: unknown; email?: unknown; mobile?: unknown } }
  const token = typeof exchanged?.token === 'string' && /^[\x21-\x7e]+$/.test(exchanged.token) ? exchanged.token : ''
  if (token === '') throw new Error('DeepSeek returned no account token')
  const user = exchanged.user
  const tokens: AuthTokens = {
    accessToken: token,
    expiresAt: 0,
    meta: {
      deviceId,
      ...(typeof user?.id === 'string' ? { accountId: user.id } : {}),
      ...(typeof user?.email === 'string' && user.email ? { email: user.email } : typeof user?.mobile === 'string' && user.mobile ? { email: user.mobile } : {})
    }
  }
  // A paid-only account is still stored, but the guard explains why turns are refused.
  callbacks.onUpdate({ message: 'Signed in', done: true })
  return tokens
}

export interface DeepSeekWallets {
  /** Granted credit per currency. */
  bonus: Record<string, number>
  /** Top-up balance per currency. */
  normal: Record<string, number>
}

function wallets(value: unknown): Record<string, number> {
  if (!Array.isArray(value)) throw new Error('DeepSeek returned no wallet list')
  const out: Record<string, number> = {}
  for (const entry of value as { currency?: unknown; balance?: unknown }[]) {
    const amount = Number(entry?.balance)
    if (typeof entry?.currency !== 'string' || typeof entry.balance !== 'string' || !Number.isFinite(amount)) throw new Error('DeepSeek returned an unreadable wallet')
    out[entry.currency] = (out[entry.currency] ?? 0) + amount
  }
  return out
}

export function parseDeepSeekSummary(value: unknown): DeepSeekWallets {
  const summary = value as { normal_wallets?: unknown; bonus_wallets?: unknown } | null
  return { normal: wallets(summary?.normal_wallets), bonus: wallets(summary?.bonus_wallets) }
}

export async function readDeepSeekWallets(token: string, signal: AbortSignal): Promise<DeepSeekWallets> {
  return parseDeepSeekSummary(await platformRequest('/api/v0/users/get_user_summary', { headers: { ...clientHeaders(), [DEEPSEEK_TOKEN_HEADER]: token } }, signal))
}

/** Why a turn may not run on these wallets, or null when only granted credit can be spent. */
export function freeCreditBlock(wallets: DeepSeekWallets): string | null {
  const paid = Object.entries(wallets.normal).filter(([, amount]) => amount > 0)
  if (paid.length > 0) return `This DeepSeek account has top-up balance (${paid.map(([currency, amount]) => `${amount} ${currency}`).join(', ')}). DeepSeek offers no granted-credit-only switch, so a request could be charged to it. Anticode uses this login for free credit only; no paid route is used.`
  if (!Object.values(wallets.bonus).some((amount) => amount > 0)) return 'This DeepSeek account has no granted credit left. Anticode uses this login for free credit only; no paid route is used.'
  return null
}

const checked = new Map<string, number>()
const verified = new Map<string, number>()
const CHECK_TTL_MS = 30_000
const GRACE_MS = 5 * 60_000

/** Throws before any inference unless the account can only spend granted credit. */
export async function assertDeepSeekFreeCredit(token: string, signal: AbortSignal): Promise<void> {
  if ((checked.get(token) ?? 0) > Date.now()) return
  let block: string | null
  try {
    block = freeCreditBlock(await readDeepSeekWallets(token, signal))
  } catch (failure) {
    // A throttled check is not a reason to end the turn: granted credit cannot
    // turn into paid balance by itself, so keep the last verified answer for a while.
    const good = verified.get(token)
    const transient = failureStatus(failure) === 202 || isTransient(failure)
    if (good !== undefined && Date.now() - good < GRACE_MS && transient) {
      checked.set(token, Date.now() + CHECK_TTL_MS)
      return
    }
    throw failure
  }
  if (block !== null) {
    checked.delete(token)
    verified.delete(token)
    throw new ProviderRequestError(block, 402, 'account')
  }
  verified.set(token, Date.now())
  checked.set(token, Date.now() + CHECK_TTL_MS)
}

export function accountLabel(tokens: AuthTokens): string | undefined {
  return tokens.meta?.email || undefined
}
