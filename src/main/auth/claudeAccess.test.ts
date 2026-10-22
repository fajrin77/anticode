import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const directory = mkdtempSync(path.join(tmpdir(), 'anticode-claude-access-'))
vi.mock('electron', () => ({ app: { getPath: () => directory }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`encrypted:${s}`), decryptString: (b: Buffer) => b.toString().slice('encrypted:'.length) } }))
import { parseClaudeAccess, checkClaudeSubscription, readClaudeAccess, resetClaudeAccessForTests, CLAUDE_ACCESS_FRESH_MS, CLAUDE_ACCESS_MAX_AGE_MS } from './claudeAccess'
import { saveAuthAccount, readAuthTokens } from './store'
import { authModelsFor, fetchClaudeModels } from './catalogue'
import { authProvider } from './provider'
import { parseClaudeQuota } from '../subscriptionQuotas'
const profile = { account: { has_claude_pro: true }, organization: { subscription_status: 'active' } }
const tokens = { accessToken: 'fixture', expiresAt: Date.now() + 3600_000 }
function save(): void { resetClaudeAccessForTests(); saveAuthAccount({ id: 'auth:claude', kind: 'claude', label: 'Fixture Claude', createdAt: Date.now(), refreshable: false }, tokens) }
beforeEach(() => resetClaudeAccessForTests())
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('requires an active subscription and explicit Extra usage off', () => {
  expect(parseClaudeAccess(profile, { extra_usage: { is_enabled: false } })).toEqual({ plan: 'pro', subscribed: true, extraUsageEnabled: false })
  expect(parseClaudeAccess({ ...profile, organization: { subscription_status: 'cancelled' } }, {}).subscribed).toBe(false)
  expect(parseClaudeAccess(profile, {}).extraUsageEnabled).toBeNull()
  expect(parseClaudeAccess({ account: { has_claude_pro: 'true' } }, {}).subscribed).toBe(false)
})

it('blocks inference when Extra usage is enabled or unknown and revokes previous eligibility', async () => {
  for (const extra of [true, undefined]) {
    save()
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: string) => {
      urls.push(String(input))
      return Response.json(String(input).endsWith('/profile') ? profile : { extra_usage: { is_enabled: extra } })
    })
    const run = async (): Promise<void> => {
      for await (const _ of authProvider('auth:claude', 'claude-sonnet-5-5').chat({ system: '', messages: [], tools: [], maxTokens: 32, signal: new AbortController().signal })) { /* consume */ }
    }
    await expect(run()).rejects.toThrow(/Extra usage/)
    expect(urls.some(url => url.includes('/v1/messages'))).toBe(false)
    expect(readAuthTokens('auth:claude')?.meta?.claudeAccessReady).toBe('false')
  }
})

it('keeps failed access checks separate from successful subscription verification', async () => {
  save()
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }))
  await expect(checkClaudeSubscription('auth:claude', tokens)).rejects.toMatchObject({ status: 503 })
  expect(readAuthTokens('auth:claude')?.meta?.claudeAccessReady).not.toBe('true')
})
it('shares a successful preflight across prompt signals while isolating tokens', async () => {
  save()
  const fetch = vi.fn(async (input: string) => Response.json(String(input).endsWith('/profile') ? profile : { extra_usage: { is_enabled: false } }))
  vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  await checkClaudeSubscription('auth:claude', tokens, signal)
  await checkClaudeSubscription('auth:claude', tokens, signal)
  expect(fetch).toHaveBeenCalledTimes(2)
  await checkClaudeSubscription('auth:claude', tokens, new AbortController().signal)
  expect(fetch).toHaveBeenCalledTimes(2)
  await checkClaudeSubscription('auth:claude', { ...tokens, accessToken: 'refreshed-fixture' }, signal)
  expect(fetch).toHaveBeenCalledTimes(4)
})

it('fetches paginated account models and retains the last complete catalogue offline', async () => {
  save()
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/profile')) return Response.json(profile)
    if (url.pathname.endsWith('/usage')) return Response.json({ extra_usage: { is_enabled: false } })
    return Response.json(url.searchParams.has('after_id') ? { data: [{ id: 'claude-opus-5-5' }], has_more: false } : { data: [{ id: 'claude-sonnet-5-5' }], has_more: true, last_id: 'claude-sonnet-5-5' })
  })
  expect(await fetchClaudeModels('auth:claude')).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5'])
  expect(readAuthTokens('auth:claude')?.meta?.claudeAccessReady).toBe('true')
  vi.stubGlobal('fetch', async () => { throw new Error('offline') })
  expect(await fetchClaudeModels('auth:claude')).toEqual(authModelsFor('auth:claude', 'claude'))
  expect(authModelsFor('auth:claude', 'claude')).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5'])
})

it('reports real 5-hour and 7-day windows without inventing a monthly allowance', () => {
  const parsed = parseClaudeQuota(profile, { five_hour: { utilization: 11, resets_at: '2026-10-21T16:59:59Z' }, seven_day: { utilization: 25 }, seven_day_opus: null, extra_usage: { is_enabled: false } })
  expect(parsed).toEqual({ plan: 'pro', extraUsageEnabled: false, windows: [{ label: '5-hour window', usedPercent: 11, resetAt: Date.parse('2026-10-21T16:59:59Z') }, { label: '7-day window', usedPercent: 25, resetAt: null }] })
})

it('keeps a long run alive through metadata 429s, without advancing the verified timestamp or permitting expired evidence', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T03:00:00Z')); save()
  const fetcher = vi.fn(async (input: string) => Response.json(String(input).endsWith('/profile') ? profile : {extra_usage:{is_enabled:false}}))
  vi.stubGlobal('fetch',fetcher)
  await Promise.all(Array.from({length:20},()=>checkClaudeSubscription('auth:claude',tokens,new AbortController().signal)))
  expect(fetcher).toHaveBeenCalledTimes(2)
  const at = readAuthTokens('auth:claude')?.meta?.claudeAccessCheckedAt
  vi.setSystemTime(Date.now()+CLAUDE_ACCESS_FRESH_MS+1)
  fetcher.mockImplementation(async()=>new Response('{}',{status:429,headers:{'retry-after':'120'}}))
  await checkClaudeSubscription('auth:claude',tokens)
  expect((await readClaudeAccess(tokens)).stale).toBe(true)
  expect(readAuthTokens('auth:claude')?.meta?.claudeAccessCheckedAt).toBe(at)
  const calls = fetcher.mock.calls.length
  await Promise.all(Array.from({length:20},()=>checkClaudeSubscription('auth:claude',tokens)))
  expect(fetcher.mock.calls.length).toBe(calls)
  vi.setSystemTime(Number(at)+CLAUDE_ACCESS_MAX_AGE_MS+1)
  await expect(checkClaudeSubscription('auth:claude',tokens)).rejects.toMatchObject({status:429,operation:'subscription-check'})
})
it('never borrows another token verification or ignores a fresh Extra usage revocation', async () => {
  vi.useFakeTimers(); save()
  vi.stubGlobal('fetch',async(input:string)=>Response.json(String(input).endsWith('/profile')?profile:{extra_usage:{is_enabled:false}}))
  await checkClaudeSubscription('auth:claude',tokens)
  vi.stubGlobal('fetch',async()=>new Response('{}',{status:429}))
  await expect(checkClaudeSubscription('auth:claude',{accessToken:'unverified-token'})).rejects.toMatchObject({status:429})
  vi.setSystemTime(Date.now()+CLAUDE_ACCESS_FRESH_MS+1)
  vi.stubGlobal('fetch',async(input:string)=>Response.json(String(input).endsWith('/profile')?profile:{extra_usage:{is_enabled:true}}))
  await expect(checkClaudeSubscription('auth:claude',tokens)).rejects.toThrow(/Extra usage/)
  expect(readAuthTokens('auth:claude')?.meta?.claudeAccessReady).toBe('false')
})
it('cancels one waiter without aborting a shared quota read for another caller', async () => {
  save(); let complete!:()=>void
  const gate=new Promise<void>(resolve=>{complete=resolve})
  const fetcher=vi.fn(async(input:string)=>{await gate;return Response.json(String(input).endsWith('/profile')?profile:{extra_usage:{is_enabled:false}})})
  vi.stubGlobal('fetch',fetcher)
  const abort=new AbortController()
  const first=readClaudeAccess(tokens,abort.signal)
  const rejected=expect(first).rejects.toBeDefined()
  const second=readClaudeAccess(tokens)
  abort.abort();complete();await rejected
  expect((await second).profile).toEqual(profile)
  expect(fetcher).toHaveBeenCalledTimes(2)
})
