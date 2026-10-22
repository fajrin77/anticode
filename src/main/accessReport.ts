import type { AccessObservation, AccessReport, AccessReportGroup, AccessSource } from '@shared/ipc'
import { listProviders } from './providers'
import { listCustomProviders } from './providers/custom'
import { clinepassConfig } from './providers/clinepass'
import { providerKeyId } from './providers/keyring'
import { loadPersistedSettings } from './settings'
import { groupAuthProviders } from '@shared/providerGroups'

export function getAccessReport(now = Date.now()): AccessReport {
  const settings = loadPersistedSettings()
  const providers = listProviders()
  const source = (id: string, label: string, credentialAvailable = true): AccessSource => {
    const saved = settings.accessObservations?.[id]
    const observations: AccessObservation[] = [...(saved?.observations ?? [])]
    // Earlier versions kept quota/cooldown facts without the new ledger. Retain
    // those facts but do not invent a cause for a bare key cooldown timestamp.
    for (const [key, mark] of Object.entries(settings.rotation?.outOfUsage ?? {})) {
      if (!key.startsWith(id + '\n') || observations.some(item => item.model === key.slice(id.length + 1))) continue
      observations.push({ state: 'quota', scope: mark.scope ?? 'model', model: key.slice(id.length + 1), checkedAt: mark.since, ...(mark.resetAt ? { retryAt: mark.resetAt } : {}) })
    }
    const activeAccount = observations.filter(item => item.scope === 'account' && (!item.retryAt || item.retryAt > now)).sort((a,b) => b.checkedAt - a.checkedAt)[0]
    const activeModel = observations.some(item => item.scope === 'model' && (!item.retryAt || item.retryAt > now))
    const state = !credentialAvailable ? 'auth' : activeAccount?.state ?? (activeModel ? 'limited' : observations.length ? 'retry' : saved?.lastSuccessAt ? 'ready' : 'unknown')
    return { id, label, state, observations, ...(saved?.lastSuccessAt ? { lastSuccessAt: saved.lastSuccessAt } : {}) }
  }
  const groups: AccessReportGroup[] = []
  for (const group of groupAuthProviders(providers).filter(provider => provider.kind === 'auth')) {
    groups.push({ id: group.authKind!, label: group.label.replace(/ · \d+ accounts$/, ''), kind: 'accounts', sources: providers.filter(provider => group.accountIds?.includes(provider.id)).map(provider => source(provider.id, provider.label, provider.credentialAvailable)) })
  }
  const clinepass = clinepassConfig()
  const keyed = [
    ...(!clinepass.removed && clinepass.apiKeys.length ? [{ id: 'clinepass', label: 'Clinepass', apiKey: clinepass.apiKeys[0]!, apiKeys: clinepass.apiKeys }] : []),
    ...listCustomProviders()
  ]
  for (const provider of keyed) {
    const keys = [...new Set([provider.apiKey, ...(provider.apiKeys ?? [])].filter(Boolean))]
    if (!keys.length) continue
    groups.push({ id: provider.id, label: provider.label, kind: 'keys', sources: keys.map((key, index) => {
      const id = providerKeyId(provider.id, key)
      const row = source(id, `Key ${index + 1}${index === 0 ? ' · primary' : ''} · ${id.slice(-8)}`)
      for (const [scope, until] of Object.entries(settings.providerKeyCooldowns ?? {})) {
        if (until <= now || scope !== id && !scope.startsWith(id + ':')) continue
        const model = scope === id ? '' : scope.slice(id.length + 1)
        if (!row.observations.some(item => item.model === model && (!item.retryAt || item.retryAt > now))) row.observations.push({ state: 'cooldown', scope: scope === id ? 'account' : 'model', model, checkedAt: now, retryAt: until })
        if (scope === id && row.state !== 'auth' && row.state !== 'quota') row.state = 'cooldown'
        else if (scope !== id && ['ready', 'unknown', 'retry'].includes(row.state)) row.state = 'limited'
      }
      return row
    }) })
  }
  return { checkedAt: now, groups }
}
