import { observeAccessFailure } from './accessLedger'
import { coolDown, coolingUntil } from './rotation'
import { ClaudeAccessCheckError } from './auth/claudeAccess'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PersistedSettings } from './settings'
import type { ProviderInfo } from '@shared/ipc'

const { saved } = vi.hoisted(() => ({ saved: {} as PersistedSettings }))
vi.mock('./settings', () => ({
  loadPersistedSettings: () => saved,
  savePersistedSettings: (patch: PersistedSettings) => Object.assign(saved, patch)
}))
import { subscriptionEntries } from './subscriptions'
import { recordRotationUsage, setRotationEntries, setRotationEnabled, setSubscriptionOnly, rankRotation, markOutOfUsage, outOfUsage, resetRotationForTests } from './rotation'
import { ProviderRequestError } from './providers/requestError'
import { parseChatGPTQuota } from './subscriptionQuotas'
import { parseCodexModels, authModelsFor, forgetAuthCatalogue } from './auth/catalogue'

beforeEach(() => { delete saved.rotation; delete saved.authModelCatalogues; resetRotationForTests() })
afterEach(() => vi.restoreAllMocks())

it('builds native routes by entitlement instead of names or arbitrary OAuth accounts', () => {
  const providers = [
    { id: 'chatgpt', billing: 'subscription' as const, credentialAvailable: true, models: ['gpt'] },
    { id: 'fake', label: 'ChatGPT subscription', credentialAvailable: true, models: ['paid'] },
    { id: 'claude', kind: 'auth' as const, billing: 'unknown' as const, credentialAvailable: true, models: ['claude'] }
  ].map((provider): ProviderInfo => ({ label: provider.id, defaultModel: '', configured: true, credentialHint: '', ...provider }))
  expect(subscriptionEntries(providers)).toEqual([{ provider: 'chatgpt', model: 'gpt' }])
})

it('blocks an exhausted account across its models, persists reset time, and recovers after reset', () => {
  const a = { provider: 'auth:codex', model: 'gpt-a' }
  const b = { provider: 'auth:codex', model: 'gpt-b' }
  const other = { provider: 'clinepass', model: 'cline-pass/kimi' }
  setRotationEntries([a, b, other])
  setRotationEnabled(true)
  setSubscriptionOnly(true)
  markOutOfUsage(a, new ProviderRequestError('usage limit reached', 429, 'account', 20_000), 10_000)
  expect(outOfUsage(b, 11_000)).toMatchObject({ scope: 'account', resetAt: 20_000 })
  const rank = (now: number): ReturnType<typeof rankRotation> => rankRotation({ ready: () => true, busy: () => 0, now })
  expect(rank(11_000)).toEqual([other])
  resetRotationForTests()
  expect(rank(15_000)).toEqual([other])
  expect(rank(21_000)).toEqual([a, b, other])
})

it('keeps absent quota facts unknown and filters model metadata without inventing entitlement', () => {
  expect(parseChatGPTQuota({ rate_limit: { primary_window: { used_percent: 40, reset_at: 123 } }, plan_type: 'plus' })).toEqual({ plan: 'plus', windows: [{ label: 'Primary window', usedPercent: 40, resetAt: 123000 }] })
  expect(parseChatGPTQuota({ rate_limit: { primary_window: {} } }).windows).toEqual([])
  expect(parseChatGPTQuota({ rate_limit: { primary_window: { reset_at: 456 } } }).windows[0]?.usedPercent).toBeNull()
  expect(parseCodexModels({ models: [{ slug: 'gpt-6.1-sol' }, { id: 'hidden', visibility: 'hide' }, { slug: 'unavailable', supported_in_api: false }, null] })).toEqual(['gpt-6.1-sol', 'unavailable'])
})


it('restores the observed account catalogue after restart and forgets it when an account is removed', () => {
  saved.authModelCatalogues = { 'auth:codex': { models: ['account-specific-model'], checkedAt: 123 } }
  expect(authModelsFor('auth:codex', 'codex')).toEqual(expect.arrayContaining(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.5', 'account-specific-model']))
  expect(authModelsFor('auth:other', 'codex')).not.toContain('account-specific-model')
  forgetAuthCatalogue('auth:codex')
  expect(authModelsFor('auth:codex', 'codex')).not.toContain('account-specific-model')
})


it('filters legacy paid Cline snapshots before a picker can use them', () => {
  saved.authModelCatalogues = { 'auth:cline': { models: ['anthropic/claude-sonnet-4.6', 'google/gemma-4-31b-it:free'], checkedAt: 123 } }
  const models = authModelsFor('auth:cline', 'cline')
  expect(models).toContain('google/gemma-4-31b-it:free')
  expect(models).toContain('nvidia/nemotron-3.5-lightning:free')
  expect(models).not.toContain('anthropic/claude-sonnet-4.6')
})


it('treats a refreshed free catalogue as authoritative instead of reintroducing expired promotions', () => {
  saved.authModelCatalogues = { 'auth:cline': { models: ['poolside/laguna-xs-2.1:free'], checkedAt: 123, freeOnly: true } }
  expect(authModelsFor('auth:cline', 'cline')).toEqual(['poolside/laguna-xs-2.1:free'])
  expect(authModelsFor('auth:cline', 'cline')).not.toContain('cline-free/muse-spark-1.3-contributor')
})


it('balances total account usage instead of favoring accounts with more models', () => {
  const a = { provider: 'auth:codex', model: 'gpt-a' }
  const spare = { provider: 'auth:codex', model: 'gpt-b' }
  const b = { provider: 'auth:codex-2', model: 'gpt-a' }
  setRotationEntries([a, spare, b])
  setRotationEnabled(true)
  recordRotationUsage(a, { inputTokens: 100, outputTokens: 0 })
  recordRotationUsage(b, { inputTokens: 20, outputTokens: 0 })
  const rank = (): ReturnType<typeof rankRotation> => rankRotation({ ready: () => true, busy: () => 0 })
  expect(rank()[0]).toEqual(b)
  setRotationEntries([a, spare, b, { provider: a.provider, model: 'new-model' }])
  expect(rank()[0]).toEqual(b)
  resetRotationForTests()
  expect(rank()[0]).toEqual(b)
})

it('does not cool an account for a transport outage or subscription metadata 429; real rate limits still cool it', () => {
  const entry={provider:'auth:claude-fixture',model:'claude-sonnet-5-5'}
  coolDown(entry,1000,new ClaudeAccessCheckError('verification unavailable',429,'account'))
  expect(coolingUntil(entry,1001)).toBeNull()
  coolDown(entry,1000,new Error('fetch failed'))
  expect(coolingUntil(entry,1001)).toBeNull()
  coolDown(entry,1000,Object.assign(new Error('real inference rate limit'),{status:429,scope:'account',retryAt:5000}))
  expect(coolingUntil(entry,1001)).toBe(5000)
})

it('does not record a false account cooldown in the access report for network or verification outages', () => {
  delete saved.accessObservations
  observeAccessFailure('auth:claude-fixture','claude-sonnet-5-5',new ClaudeAccessCheckError('verification 429',429,'account'))
  observeAccessFailure('auth:codex-fixture','gpt-6.1-sol',new Error('fetch failed'))
  expect(saved.accessObservations).toBeUndefined()
})
