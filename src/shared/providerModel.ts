import type { ProviderInfo } from './ipc'

/** Auth accounts are product-specific; a saved pool entry is never an entitlement. */
export function providerModelIssue(provider: ProviderInfo, model: string, catalogue?: readonly string[]): string | null {
  if (!provider.authKind) return null // Custom endpoints keep explicit hand-configured ids.
  const models = catalogue ?? provider.models ?? []
  const wrongFamily = provider.authKind === 'claude' && !model.startsWith('claude-')
  return wrongFamily || !models.includes(model)
    ? `Model “${model}” is not offered by ${provider.label}. This route is skipped; choose a model from this account’s catalogue.`
    : null
}
