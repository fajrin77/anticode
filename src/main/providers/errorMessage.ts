import { failureStatus } from './failures'
import { InputRequestLimitError, requestLimit } from './requestLimits'
import { isRetiredRoute, RetiredRouteError } from './routeError'

/** UI/durable display boundary: never echo serialized upstream metadata or ids. */
export function safeProviderErrorMessage(error: unknown, model = 'this model'): string {
  const limit = requestLimit(error)
  if (limit?.kind === 'input') return new InputRequestLimitError(limit.promptTokens ?? 0, limit.limitTokens ?? 0, error instanceof InputRequestLimitError && error.minimumRequest).message
  if (limit?.kind === 'payload') return 'The request exceeded the provider size limit (HTTP 413). The original images and the work are kept. Compact the conversation or send fewer new attachments before trying again. A free plan limit is never raised automatically or moved to a paid route.'
  if (isRetiredRoute(error)) return new RetiredRouteError(model).message
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'The provider refused the request.'
  const status = failureStatus(error)
  if (status === 403) return 'The provider refused access to this model route (HTTP 403); the quota is not necessarily spent. Rotate can carry on with another eligible route in your pool. If none is available, check the model permission, account or key, or the endpoint in Settings → Providers. A refused route is not retried, and no paid fallback is added.'
  if (/[{[]\s*"|\b(?:user_id|account_id|org_id|metadata|previous_errors)\b|<html/i.test(message)) {
    return `The provider refused the request${status !== undefined ? ` (HTTP ${status})` : ''}. ${status === 404 ? 'The route or endpoint is not available; refresh the model catalogue and check the provider connection.' : 'Check model access and the provider status, then try again.'}`
  }
  return message.replace(/\bBearer\s+[^\s"']+|\bsk-[\w-]+/gi, '[credential redacted]').slice(0, 2000)
}
