/** Machine-readable failure metadata shared by direct adapters and the native router. */
export class ProviderRequestError extends Error {
  constructor(message: string, readonly status: number, readonly scope: 'account' | 'model' = 'model', readonly resetAt?: number, readonly retryAt?: number) {
    super(message)
    this.name = 'ProviderRequestError'
  }
}

/** Control-plane availability must not become an inference quota or account ban. */
export function isSubscriptionCheckFailure(error: unknown): boolean {
  let current = error
  for (let i = 0; i < 5 && current && typeof current === 'object'; i++) {
    const row = current as { operation?: unknown; status?: number; cause?: unknown; error?: unknown }
    if (row.operation === 'subscription-check' && (row.status === 429 || (row.status !== undefined && row.status >= 500))) return true
    current = row.cause ?? row.error
  }
  return false
}
