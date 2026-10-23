import { beforeEach, expect, it, vi } from 'vitest'
import type { AuthKind, ProviderInfo } from '@shared/ipc'
const { settings } = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }))
vi.mock('../settings', () => ({ loadPersistedSettings: () => settings, savePersistedSettings: (patch: object) => Object.assign(settings, patch) }))
import { accountCandidates, rankAccounts, recordAccountUsage } from './sharing'
import { groupAuthProviders } from '@shared/providerGroups'
beforeEach(() => { for (const key of Object.keys(settings)) delete settings[key] })
const accounts: ProviderInfo[] = ['auth:cline', 'auth:cline-2'].map(id => ({ id, label: id, kind: 'auth', authKind: 'cline', models: ['free-model'], defaultModel: 'free-model', configured: true, credentialAvailable: true, credentialHint: '', composerVisible: true }))
const selected = { provider: 'auth:cline', model: 'free-model' }
it('shows one model tab for two accounts while preserving both backend identities', () => {
  const grouped = groupAuthProviders(accounts)
  expect(grouped).toHaveLength(1)
  expect(grouped[0]).toMatchObject({ label: 'Cline Free · 2 accounts', accountIds: ['auth:cline', 'auth:cline-2'], models: ['free-model'] })
  expect(accounts[0]?.label).toBe('auth:cline')
})
it('shares the same model across independent accounts, skips cooldowns and busy accounts, and never changes model or provider family', () => {
  const foreign = { ...accounts[0]!, id: 'auth:codex', authKind: 'codex' as const }
  const candidates = accountCandidates(selected, [...accounts, foreign])
  expect(candidates).toEqual([selected, { provider: 'auth:cline-2', model: 'free-model' }])
  recordAccountUsage('auth:cline', 100, 20)
  expect(rankAccounts(candidates, () => true, () => 0)[0]?.provider).toBe('auth:cline-2')
  expect(rankAccounts(candidates, entry => entry.provider !== 'auth:cline-2', () => 0)[0]?.provider).toBe('auth:cline')
  expect(rankAccounts(candidates, () => true, entry => entry.provider === 'auth:cline-2' ? 1 : 0)[0]?.provider).toBe('auth:cline')
  expect(accountCandidates(selected, [accounts[0]!, { ...accounts[1]!, models: ['other-model'] }])).toEqual([selected])
})
it('starts a new monthly accounting period without inventing provider quota', () => {
  settings.accountRoutingUsage = { month: '2000-01', accounts: { 'auth:cline': 99999 } }
  recordAccountUsage('auth:cline-2', 3, 2)
  expect(settings.accountRoutingUsage).toEqual({ month: new Date().toISOString().slice(0, 7), accounts: { 'auth:cline-2': 5 } })
})
it.each<AuthKind>(['codex', 'claude', 'clinepass', 'cline', 'codebuddy', 'opencode-go', 'minimax-plan', 'kilo', 'openrouter'])('distributes 25 prompts evenly over five %s accounts before any account is exhausted', (authKind) => {
  const model = authKind === 'claude' ? 'claude-fixture' : 'free-model'
  const five = Array.from({ length: 5 }, (_, index) => ({ ...accounts[0]!, authKind, models: [model], id: `auth:${authKind}-${index + 1}` }))
  const candidates = accountCandidates({ provider: five[0]!.id, model }, five)
  const prompts: Record<string, number> = {}
  const order: string[] = []
  for (let prompt = 0; prompt < 25; prompt++) {
    const next = rankAccounts(candidates, () => true, () => 0)[0]!
    expect(next.model).toBe(model)
    order.push(next.provider)
    prompts[next.provider] = (prompts[next.provider] ?? 0) + 1
    recordAccountUsage(next.provider, 100, 20)
  }
  expect(new Set(order.slice(0, 5)).size).toBe(5)
  expect(Object.values(prompts)).toEqual([5, 5, 5, 5, 5])
})

it.each<AuthKind>(['codex', 'claude', 'clinepass', 'cline', 'codebuddy', 'opencode-go', 'minimax-plan', 'kilo', 'openrouter'])('excludes disabled %s accounts even when selected or less used', (authKind) => {
  const model = authKind === 'claude' ? 'claude-fixture' : 'free-model'
  const rows = accounts.map((row, i) => ({ ...row, authKind, models: [model], composerVisible: i !== 0 }))
  const choices = accountCandidates({ ...selected, model }, rows)
  expect(choices).toEqual([{ provider: 'auth:cline-2', model }])
  recordAccountUsage('auth:cline-2', 1000, 200)
  expect(rankAccounts(choices, () => true, () => 0)[0]?.provider).toBe('auth:cline-2')
  expect(accountCandidates(selected, rows.map(row => ({ ...row, composerVisible: false })))).toEqual([])
})
