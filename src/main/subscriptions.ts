import type { ProviderInfo, RotationEntry } from '@shared/ipc'

/** Entitlement is supplied by the adapter, never inferred from a provider label. */
export function isSubscriptionProvider(provider: Pick<ProviderInfo, 'billing'>): boolean {
  return provider.billing === 'subscription' || provider.billing === 'free'
}

export function subscriptionEntries(providers: ProviderInfo[]): RotationEntry[] {
  return providers.filter((provider) => provider.credentialAvailable && isSubscriptionProvider(provider))
    .flatMap((provider) => (provider.models?.length ? provider.models : [provider.defaultModel])
      .filter((model) => model !== '').map((model) => ({ provider: provider.id, model })))
}
