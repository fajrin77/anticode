import { failureStatus } from './failures'
import { InputRequestLimitError, requestLimit } from './requestLimits'
import { isRetiredRoute, RetiredRouteError } from './routeError'

/**
 * A refused Gemini plan request carries Google's own reason class inside the
 * adapter message. Only these fixed sentences leave the boundary; no upstream
 * text, account id or project id is echoed.
 */
function geminiRefusal(message: string): string {
  if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(message)) return ' The sign-in is missing the Google Cloud scope this endpoint needs; sign in to the account again in Settings → Auth provider.'
  if (/VALIDATION_REQUIRED|verify your account|account verification/i.test(message)) return ' Google requires account verification (VALIDATION_REQUIRED) before this account can use the Gemini CLI endpoint.'
  if (/TOS_VIOLATION|SECURITY_POLICY_VIOLATED/i.test(message)) return ' Google restricted this account on the Cloud Code endpoint (TOS_VIOLATION / SECURITY_POLICY_VIOLATED).'
  if (/CONSUMER_INVALID|USER_PROJECT_DENIED|IAM_PERMISSION_DENIED/i.test(message)) return ' Google rejected the account project binding on this endpoint (CONSUMER_INVALID / IAM_PERMISSION_DENIED); try signing in again in Settings → Auth provider.'
  if (/not found for (?:API version|model)|Requested entity was not found|is not found/i.test(message)) return ' Google does not serve this model id on the endpoint the Gemini CLI uses, so no plan can run it there; pick a model the account catalogue lists.'
  if (/SERVICE_DISABLED|has not been used in project|API has not been used|it is disabled/i.test(message)) return ' Google reports this API as disabled for the account (SERVICE_DISABLED); that is an account setting, not an exhausted quota.'
  if (/onboard|FAILED_PRECONDITION/i.test(message)) return ' The account has no managed Gemini project yet and Google onboarding did not complete for this plan.'
  if (/PERMISSION_DENIED|does not have permission/i.test(message)) return ' Google answered PERMISSION_DENIED: this plan does not grant the route to this account.'
  return ''
}

/** UI/durable display boundary: never echo serialized upstream metadata or ids. */
export function safeProviderErrorMessage(error: unknown, model = 'this model'): string {
  const limit = requestLimit(error)
  if (limit?.kind === 'input') return new InputRequestLimitError(limit.promptTokens ?? 0, limit.limitTokens ?? 0, error instanceof InputRequestLimitError && error.minimumRequest).message
  if (limit?.kind === 'payload') return 'The request exceeded the provider size limit (HTTP 413). The original images and the work are kept. Compact the conversation or send fewer new attachments before trying again. A free plan limit is never raised automatically or moved to a paid route.'
  if (isRetiredRoute(error)) return new RetiredRouteError(model).message
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'The provider refused the request.'
  const status = failureStatus(error)
  if (status === 403) return `The provider refused access to this model route (HTTP 403); the quota is not necessarily spent. Rotate can carry on with another eligible route in your pool. If none is available, check the model permission, account or key, or the endpoint in Settings → Providers. A refused route is not retried, and no paid fallback is added.${geminiRefusal(message)}`
  if (/free_rate_limited|err_free_access_denied/i.test(message)) return 'OrcaRouter is not serving free routes to this account: it requires the workspace owner to link a GitHub account registered long enough to count as established, and a brand-new account does not qualify yet. Link an established GitHub account in the OrcaRouter profile, or use an OrcaRouter key with wallet credit. Free routes keep working here once the workspace qualifies; nothing is moved to a paid route automatically.'
  if (/[{[]\s*"|\b(?:user_id|account_id|org_id|metadata|previous_errors)\b|<html/i.test(message)) {
    return `The provider refused the request${status !== undefined ? ` (HTTP ${status})` : ''}. ${status === 404 ? 'The route or endpoint is not available; refresh the model catalogue and check the provider connection.' : 'Check model access and the provider status, then try again.'}`
  }
  return message.replace(/\bBearer\s+[^\s"']+|\bsk-[\w-]+/gi, '[credential redacted]').slice(0, 2000)
}
