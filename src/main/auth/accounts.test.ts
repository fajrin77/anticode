import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AuthKind, AuthTokens } from './types'
const { flows } = vi.hoisted(() => ({ flows: { clinepass: vi.fn(), codex: vi.fn(), cline: vi.fn(), claude: vi.fn(), codebuddy: vi.fn(), 'opencode-go': vi.fn(), kilo: vi.fn(), openrouter: vi.fn(), vercel: vi.fn(), 'minimax-plan': vi.fn() } }))
const profile = mkdtempSync(path.join(tmpdir(), 'anticode-multi-account-'))
vi.mock('electron', () => ({ app: { getPath: () => profile }, safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`sealed:${s}`),
  decryptString: (s: Buffer) => s.toString().slice(7)
} }))
vi.mock('./clinepass', () => ({ loginClinePass: flows.clinepass, clinePassIdentity: vi.fn() }))
vi.mock('./codex', () => ({ loginCodex: flows.codex, accountLabel: (t: AuthTokens) => t.meta?.email, refreshCodex: vi.fn() }))
vi.mock('./cline', () => ({ loginCline: flows.cline, accountLabel: (t: AuthTokens) => t.meta?.email, refreshCline: vi.fn() }))
vi.mock('./claude', () => ({ loginClaude: flows.claude, accountLabel: (t: AuthTokens) => t.meta?.email, refreshClaude: vi.fn() }))
vi.mock('./kilo', () => ({ loginKilo: flows.kilo }))
vi.mock('./openrouter', () => ({ loginOpenRouter: flows.openrouter }))
vi.mock('./vercel', () => ({ loginVercel: flows.vercel, VERCEL_GATEWAY_BASE: 'https://ai-gateway.vercel.sh/v1' }))
vi.mock('./minimaxPlan', () => ({ loginMiniMaxPlan: flows['minimax-plan'], MINIMAX_PLAN_MODELS: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5'] }))
vi.mock('./opencodeGo', () => ({ loginOpenCodeGo: flows['opencode-go'] }))
vi.mock('./codebuddy', () => ({ loginCodebuddy: flows.codebuddy, accountLabel: (t: AuthTokens) => t.meta?.email }))
import { loginAuthAccount, listAuthAccountSummaries, renameAuthAccount } from './index'
import { readAuthTokens, resetAuthStoreForTests } from './store'
const callbacks = () => ({ signal: new AbortController().signal, onUpdate: () => {}, promptForCode: async () => '' })
const tokens = (email: string, key: string): AuthTokens => ({ accessToken: key, refreshToken: `refresh-${key}`, meta: { email } })
beforeEach(() => { rmSync(path.join(profile, 'auth-accounts.json'), { force: true }); resetAuthStoreForTests(); vi.clearAllMocks() })

it.each<AuthKind>(['codex', 'clinepass', 'cline', 'claude', 'codebuddy', 'kilo'])('keeps multiple %s identities separate and reconnects a duplicate without another usage slot', async kind => {
  flows[kind as keyof typeof flows].mockResolvedValueOnce(tokens('one@example.test', 'first-secret'))
  const first = await loginAuthAccount(kind, callbacks())
  flows[kind as keyof typeof flows].mockResolvedValueOnce(tokens('two@example.test', 'second-secret'))
  const second = await loginAuthAccount(kind, callbacks())
  expect(first.id).toBe(`auth:${kind}`)
  expect(second.id).toBe(`auth:${kind}-2`)
  renameAuthAccount(first.id, 'Personal')
  flows[kind as keyof typeof flows].mockResolvedValueOnce(tokens('ONE@example.test', 'renewed-secret'))
  const renewed = await loginAuthAccount(kind, callbacks())
  expect(renewed.id).toBe(first.id)
  expect(renewed.label).toBe('Personal')
  expect(listAuthAccountSummaries()).toHaveLength(2)
  expect(readAuthTokens(first.id)?.accessToken).toBe('renewed-secret')
  expect(readAuthTokens(second.id)?.accessToken).toBe('second-secret')
  resetAuthStoreForTests()
  expect(listAuthAccountSummaries()).toHaveLength(2)
  const disk = readFileSync(path.join(profile, 'auth-accounts.json'), 'utf8')
  expect(disk).not.toContain('renewed-secret')
  expect(disk).not.toContain('second-secret')
})

it('keeps distinct ChatGPT account ids separate even when the email is the same', async () => {
  flows.codex.mockResolvedValueOnce({ ...tokens('same@example.test', 'one'), meta: { email: 'same@example.test', accountId: 'personal' } })
  const first = await loginAuthAccount('codex', callbacks())
  flows.codex.mockResolvedValueOnce({ ...tokens('same@example.test', 'two'), meta: { email: 'same@example.test', accountId: 'business' } })
  const second = await loginAuthAccount('codex', callbacks())
  expect(second.id).not.toBe(first.id)
})


it('deduplicates OpenRouter browser approvals by returned user identity', async () => {
  flows.openrouter.mockResolvedValueOnce({ accessToken: 'first-key', expiresAt: 0, meta: { accountId: 'user-one' } })
  const first = await loginAuthAccount('openrouter', callbacks())
  flows.openrouter.mockResolvedValueOnce({ accessToken: 'new-key', expiresAt: 0, meta: { accountId: 'user-one' } })
  expect((await loginAuthAccount('openrouter', callbacks())).id).toBe(first.id)
  expect(listAuthAccountSummaries()).toHaveLength(1)
  expect(readAuthTokens(first.id)?.accessToken).toBe('new-key')
  expect(readFileSync(path.join(profile, 'auth-accounts.json'), 'utf8')).not.toContain('new-key')
})
