import { beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
const profile = mkdtempSync(path.join(tmpdir(), 'anticode-pass-test-'))
const fixtures = vi.hoisted(() => ({ login: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => profile }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`sealed:${s}`), decryptString: (b: Buffer) => b.toString().slice(7) } }))
vi.mock('./cline', () => ({ loginCline: fixtures.login }))
import { parseClinePassQuota, loginClinePass } from './clinepass'
import { importLegacyProvider, getCustomProvider } from '../providers/custom'
import { migrateClinePassAccount } from './clinepassMigration'
import { readAuthTokens, listAuthAccounts } from './store'
import { authProvider } from './provider'
const usage = { success: true, data: { limits: [{ type: 'five_hour', percentUsed: 0, resetsAt: '2026-10-22T06:13:16Z' }, { type: 'weekly', percentUsed: 34, resetsAt: '2026-10-25T08:21:02Z' }, { type: 'monthly', percentUsed: 17, resetsAt: '2026-11-17T08:21:02Z' }] } }
beforeEach(() => { vi.unstubAllGlobals(); fixtures.login.mockReset() })
it('parses actual service envelopes and preserves unknown values', () => {
  expect(parseClinePassQuota(usage).map(w => w.usedPercent)).toEqual([0, 34, 17])
  expect(parseClinePassQuota({ limits: [{ type: 'weekly', percentUsed: null, resetsAt: 'invalid' }] })).toEqual([{label:'Weekly',usedPercent:null,resetAt:null}])
  expect(() => parseClinePassQuota({success:false})).toThrow()
  expect(parseClinePassQuota({limits:[]})).toEqual([])
})
it('migrates a saved plan key while retaining its id and model choices; tokens remain sealed', async () => {
  importLegacyProvider({id:'clinepass',label:'Clinepass',kind:'openai',baseURL:'https://api.cline.bot/api/v1',apiKey:'fixture-pass-key',models:['cline-pass/test']})
  migrateClinePassAccount(); migrateClinePassAccount()
  expect(getCustomProvider('clinepass')).toBeUndefined()
  expect(listAuthAccounts()).toHaveLength(1)
  expect(listAuthAccounts()[0]).toMatchObject({id:'clinepass',kind:'clinepass'})
  expect(readAuthTokens('clinepass')?.accessToken).toBe('fixture-pass-key')
  expect(readFileSync(path.join(profile,'auth-accounts.json'),'utf8')).not.toContain('fixture-pass-key')
  const client = authProvider('clinepass','paid/model')
  const fetcher = vi.fn(); vi.stubGlobal('fetch',fetcher)
  await expect(async () => {for await (const _ of client.chat({system:'',maxTokens:32,messages:[],tools:[],signal:new AbortController().signal})) {/* consume */}}).rejects.toThrow(/Usage-billing/)
  expect(fetcher).not.toHaveBeenCalled()
})
it('browser login validates the subscription, keeps identity for deduplication, and does not enable usage billing', async () => {
  fixtures.login.mockResolvedValue({accessToken:'fixture-oauth',refreshToken:'fixture-refresh'})
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({success:true,data:{subscriptionId:'fixture-subscription',plan:{isActive:true,entitlements:{cline_pass:{enabled:true}}}}})).mockResolvedValueOnce(Response.json(usage))
  vi.stubGlobal('fetch',fetcher)
  const tokens = await loginClinePass({signal:new AbortController().signal,onUpdate:()=>{},promptForCode:async()=>''})
  expect(tokens.meta?.accountId).toBe('fixture-subscription')
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it('rejects a free-only account without changing its connection', async () => {
  fixtures.login.mockResolvedValue({accessToken:'fixture-free'})
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({success:true,data:{plan:{isActive:true,entitlements:{}}}})))
  await expect(loginClinePass({signal:new AbortController().signal,onUpdate:()=>{},promptForCode:async()=>''})).rejects.toThrow(/active ClinePass/)
})
