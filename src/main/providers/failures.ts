import { isOutOfUsage } from '../usageErrors'
import { isSubscriptionCheckFailure } from './requestError'
import { requestLimit } from './requestLimits'

export function failureStatus(error: unknown): number | undefined {
  let current = error
  for (let i = 0; i < 5 && current && typeof current === 'object'; i++) {
    const record = current as { status?: unknown; statusCode?: unknown; cause?: unknown; error?: unknown }
    const status = record.status ?? record.statusCode
    if (typeof status === 'number') return status
    current = record.cause ?? record.error
  }
  return undefined
}

const NETWORK_CODES = /^(ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETDOWN|ENETUNREACH|EPIPE|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/i

/** Explicit account/key refusals, distinct from model/product restrictions. */
export function isAccountAccessFailure(error: unknown): boolean {
  if (failureStatus(error) !== 403) return false
  const record = error as { code?: unknown; error?: { code?: unknown } }
  return ['email_verification_required', 'api_key_disabled', 'key_disabled', 'invalid_api_key'].includes(String(record.error?.code ?? record.code))
}

export function isTransient(error: unknown): boolean {
  if (requestLimit(error)?.kind === 'inflight') return true
  const status = failureStatus(error)
  // A permanent HTTP error must not become retryable because its message
  // mentions a network, timeout, or a model capability.
  if (status !== undefined) return status === 408 || status === 429 || (status >= 500 && status <= 599)
  let current = error
  for (let i = 0; i < 5 && current && typeof current === 'object'; i++) {
    const record = current as { code?: unknown; message?: unknown; cause?: unknown; error?: unknown }
    if (typeof record.code === 'string' && NETWORK_CODES.test(record.code)) return true
    if (typeof record.message === 'string' && /fetch failed|terminated|other side closed|network|connection (?:lost|reset|refused|error)|socket|timed? ?out|timeout|temporarily unavailable|rate limited/i.test(record.message)) return true
    current = record.cause ?? record.error
  }
  return false
}

/** Replay only before useful output; callers enforce that boundary. */
export function canRotateAfterRefusal(error: unknown): boolean {
  // An inference refusal can skip this exact route inside the user's pool;
  // a failed subscription safety check must not be treated as inference.
  return failureStatus(error) === 403 && !isSubscriptionCheckFailure(error)
}

export function canFailOver(error: unknown): boolean {
  return isOutOfUsage(error) || failureStatus(error) === 401 || isAccountAccessFailure(error) || isTransient(error)
}

/** Transport failure without a provider HTTP refusal; it says nothing about quota. */
export function isTransportFailure(error: unknown): boolean {
  if (failureStatus(error) !== undefined) return false
  let current = error
  for (let i = 0; i < 5 && current && typeof current === 'object'; i++) {
    const row = current as { code?: unknown; message?: unknown; cause?: unknown; error?: unknown }
    if (typeof row.code === 'string' && NETWORK_CODES.test(row.code)) return true
    if (typeof row.message === 'string' && /fetch failed|other side closed|network|connection (?:lost|reset|refused|error)|socket|timed? ?out|timeout/i.test(row.message)) return true
    current = row.cause ?? row.error
  }
  return false
}
