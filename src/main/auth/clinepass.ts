import { loginCline } from './cline'
import { CLINE_API_BASE, CLINE_HEADERS, clineApiToken } from '../providers/clineConfig'
import type { AuthLoginCallbacks, AuthTokens } from './types'
import type { SubscriptionQuota } from '@shared/ipc'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function unwrapCline(value: unknown): unknown {
  const data = record(value)
  if (data.success === false) throw new Error('ClinePass did not return account data')
  return data.success === true ? data.data : value
}

/** The account service reports plan limits, never the local token ledger. */
export function parseClinePassQuota(value: unknown): SubscriptionQuota['windows'] {
  const data = record(unwrapCline(value))
  const windows: SubscriptionQuota['windows'] = []
  for (const [key, label] of [['five_hour', '5-hour window'], ['weekly', 'Weekly'], ['monthly', 'Monthly']]) {
    const raw = record(Array.isArray(data.limits) ? data.limits.find(row => record(row).type === key) : data[key!])
    if (!Object.keys(raw).length) continue
    const used = raw.percentUsed
    const reset = typeof raw.resetsAt === 'string' ? Date.parse(raw.resetsAt) : NaN
    windows.push({ label: label!, usedPercent: typeof used === 'number' && Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : null, resetAt: Number.isFinite(reset) ? reset : null })
  }
  return windows
}

async function readClinePassAccount(tokens: AuthTokens, path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${CLINE_API_BASE}/users/me/plan${path}`, {
    headers: { ...CLINE_HEADERS, authorization: `Bearer ${clineApiToken(tokens.accessToken)}`, accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw Object.assign(new Error('ClinePass quota unavailable'), { status: response.status })
  return unwrapCline(await response.json())
}

export function readClinePassUsage(tokens: AuthTokens, signal?: AbortSignal): Promise<unknown> {
  return readClinePassAccount(tokens, '/usage-limits', signal)
}

export async function clinePassIdentity(tokens: AuthTokens, signal?: AbortSignal): Promise<string | undefined> {
  const subscription = record(await readClinePassAccount(tokens, '', signal))
  return typeof subscription.subscriptionId === 'string' ? subscription.subscriptionId : undefined
}

/** ClinePass shares browser identity with Cline Free, but remains a separate account pool. */
export async function loginClinePass(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const tokens = await loginCline({ ...callbacks, onUpdate: update => callbacks.onUpdate({ ...update, done: false }) })
  callbacks.onUpdate({ message: 'Checking ClinePass subscription' })
  const subscription = record(await readClinePassAccount(tokens, '', callbacks.signal))
  const plan = record(subscription.plan)
  if (plan.isActive !== true || record(record(plan.entitlements).cline_pass).enabled !== true) throw new Error('An active ClinePass subscription is required. Cline Free accounts stay separate; no usage-billing fallback is enabled.')
  const usage = await readClinePassUsage(tokens, callbacks.signal)
  if (!parseClinePassQuota(usage).length) throw new Error('ClinePass limits were not returned. Check your subscription in the Cline dashboard. No usage-billing fallback is enabled.')
  return { ...tokens, meta: { ...tokens.meta, ...(typeof subscription.subscriptionId === 'string' ? { accountId: subscription.subscriptionId } : {}) } }
}
