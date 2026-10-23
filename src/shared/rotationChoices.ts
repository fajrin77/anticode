import { providerModelIssue } from './providerModel'
import type { ModelCatalogue, ProviderInfo, RotationEntry } from './ipc'
import { modelIsBatchOnly } from './ipc'
import { groupAuthProviders } from './providerGroups'

export interface RotationChoice {
  id: string
  label: string
  entries: RotationEntry[]
  accounts: number
}

/** Search grouping only: each entry retains its exact provider and route id. */
export function modelSearchKey(model: string): string {
  return model.split('/').at(-1)!.replace(/:free$/i, '').toLowerCase().replace(/v(?=\d)/g, '').replace(/[^a-z0-9.]/g, '')
}

export function rotationChoices(providers: ProviderInfo[], catalogues: ModelCatalogue[], selected: RotationEntry[]): { services: RotationChoice[]; models: RotationChoice[] } {
  const entries = providers.filter(provider => provider.credentialAvailable).flatMap(provider => {
    const catalogue = catalogues.find(item => item.provider === provider.id)
    if (!catalogue || catalogue.error !== null) return []
    return [...new Set(catalogue.models)].filter(model => !modelIsBatchOnly(model) && providerModelIssue(provider, model, catalogue.models) === null && (
      provider.billing === 'free' || provider.billing === 'subscription' ||
      // Broad discovery never silently opts a metered/unknown provider into new paid routes.
      selected.some(entry => entry.provider === provider.id && entry.model === model)
    )).map(model => ({ provider: provider.id, model }))
  })
  const choice = (id: string, label: string, routes: RotationEntry[]): RotationChoice => ({ id, label, entries: routes, accounts: new Set(routes.map(entry => entry.provider)).size })
  const services = groupAuthProviders(providers).flatMap(provider => {
    const ids = provider.accountIds ?? [provider.id]
    const routes = entries.filter(entry => ids.includes(entry.provider))
    return routes.length ? [choice(provider.id, provider.label, routes)] : []
  })
  const families = new Map<string, RotationEntry[]>()
  for (const entry of entries) {
    const key = modelSearchKey(entry.model)
    const routes = families.get(key) ?? []
    routes.push(entry)
    families.set(key, routes)
  }
  const models = [...families].map(([id, routes]) => choice(id, routes[0]!.model.split('/').at(-1)!.replace(/:free$/i, ''), routes)).sort((a, b) => a.label.localeCompare(b.label))
  return { services, models }
}
