import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AuthAccount } from './auth/types'
const fixture = vi.hoisted(() => ({ accounts: [] as AuthAccount[], claude: vi.fn(), other: [] as any[] }))
vi.mock('./auth/store', () => ({ listAuthAccounts: () => fixture.accounts }))
vi.mock('./auth/provider', () => ({ ensureFreshAuthTokens: async () => ({ accessToken: 'fixture-secret' }) }))
vi.mock('./auth/claudeAccess', async original => ({ ...await original<typeof import('./auth/claudeAccess')>(), readClaudeAccess: fixture.claude, recordClaudeAccess: vi.fn() }))
vi.mock('./providers', () => ({ listProviders: () => fixture.other }))
import { getSubscriptionQuotas, parseChatGPTQuota, parseClaudeQuota } from './subscriptionQuotas'

beforeEach(() => { fixture.accounts = []; fixture.other = []; fixture.claude.mockReset() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
const account = (id: string, kind: AuthAccount['kind'] = 'claude'): AuthAccount => ({ id, kind, label: 'Fixture account', account: 'fixture@example.test', createdAt: 1, refreshable: true })
const profile = { account: { has_claude_pro: true }, organization: { subscription_status: 'active' } }
const usage = { five_hour: { utilization: 17, resets_at: '2026-10-22T06:10:00Z' }, seven_day: { utilization: 35, resets_at: '2026-10-27T16:00:00Z' } }

it('reads provider percentages and reset windows without manufacturing missing values', () => {
  expect(parseClaudeQuota(profile, usage).windows.map(w => w.usedPercent)).toEqual([17, 35])
  expect(parseClaudeQuota(profile, { five_hour: { utilization: null, resets_at: 'invalid' } }).windows[0]).toEqual({ label: '5-hour window', usedPercent: null, resetAt: null })
  expect(parseChatGPTQuota({ rate_limit: { primary_window: { used_percent: 20, reset_at: 1234, limit_window_seconds: 18000 }, secondary_window: { used_percent: 30, limit_window_seconds: 604800 } } }).windows).toEqual([{ label: '5-hour window', usedPercent: 20, resetAt: 1234000 }, { label: '7-day window', usedPercent: 30, resetAt: null }])
})
it('coalesces simultaneous views, caches briefly, and keeps the last good data after a 429', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T03:00:00Z'))
  fixture.accounts = [account('auth:cache-fixture')]
  fixture.claude.mockResolvedValue({ profile, usage })
  const [first, second] = await Promise.all([getSubscriptionQuotas(), getSubscriptionQuotas()])
  expect(fixture.claude).toHaveBeenCalledTimes(1)
  expect(second).toEqual(first)
  expect(first[0]).toMatchObject({ status: 'ok', account: 'fixture@example.test' })
  await getSubscriptionQuotas(); expect(fixture.claude).toHaveBeenCalledTimes(1)
  vi.setSystemTime(Date.now() + 61_000)
  fixture.claude.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }))
  const stale = (await getSubscriptionQuotas())[0]!
  expect(stale).toMatchObject({ status: 'stale', checkedAt: first[0]!.checkedAt, windows: first[0]!.windows })
  expect(stale.error).toMatch(/membatasi/)
  expect(JSON.stringify(stale)).not.toContain('fixture-secret')
})
it('shows each account and unsupported key plans explicitly without probing guessed endpoints', async () => {
  fixture.accounts = [account('auth:cline-test', 'cline'), account('auth:buddy-test', 'codebuddy')]
  fixture.other = [{ id: 'clinepass', label: 'Clinepass', billing: 'subscription', credentialAvailable: true }]
  const rows = await getSubscriptionQuotas()
  expect(rows).toHaveLength(3)
  expect(rows.every(q => q.status === 'unsupported' && q.windows.length === 0)).toBe(true)
  expect(fixture.claude).not.toHaveBeenCalled()
})
it('does not report a missing quota as zero usage', async () => {
  fixture.accounts = [account('auth:offline-fixture')]
  fixture.claude.mockRejectedValue(new Error('offline'))
  expect((await getSubscriptionQuotas())[0]).toMatchObject({ status: 'unavailable', windows: [] })
})
