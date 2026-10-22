import { parseClinePassQuota, readClinePassUsage } from './auth/clinepass'
import type { SubscriptionQuota } from '@shared/ipc'
import { listAuthAccounts } from './auth/store'
import { ensureFreshAuthTokens } from './auth/provider'
import { readClaudeAccess, recordClaudeAccess, parseClaudeAccess } from './auth/claudeAccess'
import { listProviders } from './providers'
import type { AuthAccount } from './auth/types'

const cache = new Map<string, { value: SubscriptionQuota; retryAt: number }>()
const pending = new Map<string, Promise<SubscriptionQuota>>()
const REFRESH_MS = 60_000

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function parseChatGPTQuota(value: unknown): Pick<SubscriptionQuota, 'windows' | 'plan'> {
  const data = record(value)
  const limits = record(data.rate_limit)
  const windows: SubscriptionQuota['windows'] = []
  for (const [key, label] of [['primary_window', 'Primary window'], ['secondary_window', 'Secondary window']]) {
    const raw = record(limits[key!])
    if (Object.keys(raw).length === 0) continue
    const used = raw.used_percent
    const reset = raw.reset_at
    const windowLabel = raw.limit_window_seconds === 18000 ? '5-hour window' : raw.limit_window_seconds === 604800 ? '7-day window' : label!
    windows.push({ label: windowLabel,
      usedPercent: typeof used === 'number' && Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : null,
      resetAt: typeof reset === 'number' && Number.isFinite(reset) && reset > 0 ? reset * 1000 : null })
  }
  return { windows, ...(typeof data.plan_type === 'string' ? { plan: data.plan_type } : {}) }
}

export function parseClaudeQuota(profile: unknown, usage: unknown): Pick<SubscriptionQuota, 'windows' | 'plan' | 'extraUsageEnabled'> {
  const data = record(usage)
  const access = parseClaudeAccess(profile, usage)
  const windows: SubscriptionQuota['windows'] = []
  for (const [key, label] of [['five_hour', '5-hour window'], ['seven_day', '7-day window'], ['seven_day_opus', 'Opus 7-day window'], ['seven_day_sonnet', 'Sonnet 7-day window'], ['seven_day_oauth_apps', 'OAuth apps 7-day window']]) {
    const raw = record(data[key!])
    if (!Object.keys(raw).length) continue
    const reset = typeof raw.resets_at === 'string' ? Date.parse(raw.resets_at) : NaN
    windows.push({ label: label!, usedPercent: typeof raw.utilization === 'number' && Number.isFinite(raw.utilization) ? Math.max(0, Math.min(100, raw.utilization)) : null, resetAt: Number.isFinite(reset) ? reset : null })
  }
  return { windows, ...(access.plan ? { plan: access.plan } : {}), extraUsageEnabled: access.extraUsageEnabled }
}

async function accountQuota(account: AuthAccount): Promise<SubscriptionQuota> {
  const key = JSON.stringify([account.id, account.createdAt, account.account])
  const base = { provider: account.id, label: account.label, authKind: account.kind, ...(account.account ? { account: account.account } : {}), checkedAt: Date.now() }
  if (account.kind !== 'claude' && account.kind !== 'codex' && account.kind !== 'clinepass') return { ...base, status: 'unsupported', windows: [], error: 'Data batas paket dari layanan ini belum tersedia.' }
  const previous = cache.get(key)
  if (previous && previous.retryAt > Date.now()) return { ...previous.value, label: account.label }
  const existing = pending.get(key)
  if (existing) return existing
  const request = (async (): Promise<SubscriptionQuota> => {
    try {
      const tokens = await ensureFreshAuthTokens(account.id)
      if (account.kind === 'clinepass') {
        const windows = parseClinePassQuota(await readClinePassUsage(tokens))
        return { ...base, windows, plan: 'ClinePass', status: windows.length ? 'ok' : 'unavailable', checkedAt: Date.now(), ...(windows.length ? {} : { error: 'ClinePass tidak mengembalikan batas paket. Hubungkan akun melalui Sign in di Auth provider.' }) }
      }
      if (account.kind === 'claude') {
        const raw = await readClaudeAccess(tokens)
        recordClaudeAccess(account.id, tokens, raw)
        const parsed = parseClaudeQuota(raw.profile, raw.usage)
        return { ...base, ...parsed, status: raw.stale ? 'stale' : parsed.windows.length ? 'ok' : 'unavailable', checkedAt: raw.checkedAt ?? Date.now(), ...(raw.stale ? { error: 'Pembacaan Claude dibatasi sementara. Menampilkan data terakhir.' } : {}), ...(parsed.windows.length === 0 ? { error: 'Claude tidak mengembalikan data batas paket.' } : {}) }
      }
      const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
        headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json',
          ...(tokens.meta?.accountId ? { 'chatgpt-account-id': tokens.meta.accountId } : {}) },
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) throw Object.assign(new Error('Quota unavailable'), { status: response.status })
      const parsed = parseChatGPTQuota(await response.json())
      return { ...base, ...parsed, status: parsed.windows.length ? 'ok' : 'unavailable', checkedAt: Date.now(), ...(parsed.windows.length === 0 ? { error: 'Layanan tidak mengembalikan data batas paket.' } : {}) }
    } catch (error) {
      const status = (error as { status?: number })?.status
      const reason = status === 429 ? 'Layanan membatasi pembacaan kuota. Coba lagi nanti.' : `Kuota belum dapat dibaca${status ? ` (HTTP ${status})` : ''}. Periksa koneksi akun.`
      if (previous?.value.windows.length) return { ...previous.value, label: account.label, status: 'stale', error: reason }
      return { ...base, status: 'unavailable', windows: [], error: reason }
    }
  })()
  pending.set(key, request)
  try {
    const value = await request
    cache.set(key, { value, retryAt: Date.now() + REFRESH_MS })
    return value
  } finally { pending.delete(key) }
}

/** Provider quota only. Coalesced across Usage/Auth views; never sends inference. */
export async function getSubscriptionQuotas(): Promise<SubscriptionQuota[]> {
  const accounts = listAuthAccounts()
  const quotas = await Promise.all(accounts.map(accountQuota))
  const ids = new Set(accounts.map(account => account.id))
  for (const provider of listProviders()) {
    if (!ids.has(provider.id) && provider.billing === 'subscription' && provider.credentialAvailable) quotas.push({ provider: provider.id, label: provider.label, checkedAt: Date.now(), status: 'unsupported', windows: [], error: 'Data batas paket dari layanan ini belum tersedia.' })
  }
  return quotas
}
