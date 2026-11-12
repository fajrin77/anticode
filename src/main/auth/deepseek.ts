import { shell } from 'electron'
import { arch, platform, release } from 'node:os'
import { randomUUID } from 'node:crypto'
import { APP_VERSION } from '../version'
import { ProviderRequestError } from '../providers/requestError'
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

async function platformRequest(path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${DEEPSEEK_PLATFORM}${path}`, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
  if (response.status === 401) throw new ProviderRequestError('The DeepSeek login has expired. Sign in again in Settings → Auth provider.', 401, 'account')
  if (!response.ok) throw new ProviderRequestError(`DeepSeek Platform answered HTTP ${response.status}`, response.status)
  return platformData(await response.json())
}

/** Only Platform pages on the fixed path may be opened in the browser. */
export function platformPage(value: unknown, path: string): string {
  const url = new URL(String(value))
  if (url.origin !== DEEPSEEK_PLATFORM || url.pathname !== path || url.username || url.password || url.hash) throw new Error('DeepSeek returned an unexpected login page')
  return url.href
}

export async function loginDeepSeek(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
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
  const deviceId = randomUUID()
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
const CHECK_TTL_MS = 30_000

/** Throws before any inference unless the account can only spend granted credit. */
export async function assertDeepSeekFreeCredit(token: string, signal: AbortSignal): Promise<void> {
  if ((checked.get(token) ?? 0) > Date.now()) return
  const block = freeCreditBlock(await readDeepSeekWallets(token, signal))
  if (block !== null) {
    checked.delete(token)
    throw new ProviderRequestError(block, 402, 'account')
  }
  checked.set(token, Date.now() + CHECK_TTL_MS)
}

export function accountLabel(tokens: AuthTokens): string | undefined {
  return tokens.meta?.email || undefined
}
