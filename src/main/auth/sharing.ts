import { providerModelIssue } from '@shared/providerModel'
import type { ProviderInfo, ProviderSelection } from '@shared/ipc'
import { loadPersistedSettings, savePersistedSettings } from '../settings'

function monthlyUsage(): Record<string, number> {
  const month = new Date().toISOString().slice(0, 7)
  const stored = loadPersistedSettings().accountRoutingUsage
  return stored?.month === month ? stored.accounts : {}
}
export function recordAccountUsage(id: string, input: number, output: number): void {
  if (id !== 'clinepass' && !id.startsWith('auth:') && !id.startsWith('apikey:')) return
  const accounts = monthlyUsage()
  savePersistedSettings({ accountRoutingUsage: { month: new Date().toISOString().slice(0, 7), accounts: {
    ...accounts, [id]: (accounts[id] ?? 0) + Math.max(0, input || 0) + Math.max(0, output || 0)
  } } })
}
export function accountCandidates(choice: ProviderSelection, providers: ProviderInfo[]): ProviderSelection[] {
  const selected = providers.find((provider) => provider.id === choice.provider)
  if (!selected?.authKind) return [choice]
  return providers.filter((provider) => provider.authKind === selected.authKind && provider.composerVisible !== false && provider.credentialAvailable && provider.models?.includes(choice.model) && providerModelIssue(provider, choice.model) === null)
    .map((provider) => ({ provider: provider.id, model: choice.model }))
}
export function rankAccounts(candidates: ProviderSelection[], available: (entry: ProviderSelection) => boolean, busy: (entry: ProviderSelection) => number): ProviderSelection[] {
  const usage = monthlyUsage()
  return candidates.filter(available).map((entry, index) => ({ entry, index, busy: busy(entry), usage: usage[entry.provider] ?? 0 }))
    .sort((a, b) => a.busy - b.busy || a.usage - b.usage || a.index - b.index).map(({ entry }) => entry)
}

export function accountRoutingTokens(id: string): number { return monthlyUsage()[id] ?? 0 }
