import { expect, it } from 'vitest'
import type { ProviderInfo, ModelCatalogue } from './ipc'
import { rotationChoices, modelSearchKey } from './rotationChoices'
const route = 'deepseek/deepseek-v4.1-flash:free'
const account = (id: string, authKind: ProviderInfo['authKind'], models = [route]): ProviderInfo => ({ id, ...(authKind ? { authKind } : {}), kind: 'auth', models, billing: 'free', label: id, defaultModel: models[0] ?? '', credentialAvailable: true, configured: true, credentialHint: '' })
const catalogue = (provider: string, models: string[], error: string | null = null): ModelCatalogue => ({ provider, models, error })

it('adds all Cline accounts, preserves each exact route, and matches a spaced model search across services', () => {
  const providers = [account('a', 'cline'), account('b', 'cline'), account('c', 'kilo', ['deepseek-v4.1-flash']), account('d', 'claude', ['claude-sonnet-5-5'])]
  const result = rotationChoices(providers, providers.map(provider => catalogue(provider.id, provider.models!)), [])
  expect(result.services.find(choice => choice.id === 'a')?.entries).toEqual([{ provider: 'a', model: route }, { provider: 'b', model: route }])
  expect(result.models.find(choice => choice.id === modelSearchKey('Deepseek 4.1 Flash'))?.entries).toEqual([{ provider: 'a', model: route }, { provider: 'b', model: route }, { provider: 'c', model: 'deepseek-v4.1-flash' }])
  expect(result.models.find(choice => choice.id === modelSearchKey('Deepseek 4.1 Flash'))?.accounts).toBe(3)
})
it('never copies unsupported models, failed catalogues, missing accounts, batch or unselected metered routes', () => {
  const providers = [account('claude', 'claude', [route]), account('offline', 'cline'), { ...account('metered', undefined), kind: 'openai' as const, billing: 'metered' as const }, { ...account('missing', 'cline'), credentialAvailable: false }]
  const cats = providers.map(provider => catalogue(provider.id, provider.models!, provider.id === 'offline' ? 'network' : null))
  expect(rotationChoices(providers, cats, []).models).toEqual([])
  expect(rotationChoices(providers, cats, [{ provider: 'metered', model: route }]).models[0]?.entries).toEqual([{ provider: 'metered', model: route }])
  expect(rotationChoices([account('a', 'cline')], [catalogue('a', ['model:batch', route, route])], []).models.flatMap(choice => choice.entries)).toHaveLength(1)
})
it('does not infer one account’s models from another or combine different model versions', () => {
  const providers = [account('a', 'cline'), account('b', 'cline', [])]
  const result = rotationChoices(providers, [catalogue('a', [route, 'deepseek-v4-flash:free']), catalogue('b', [])], [])
  expect(result.services[0]?.accounts).toBe(1)
  expect(result.models).toHaveLength(2)
})
