import { isSubscriptionCheckFailure } from './providers/requestError'
import type { AccessObservation } from '@shared/ipc'
import { loadPersistedSettings, savePersistedSettings } from './settings'
import { failureStatus, isAccountAccessFailure, isTransient, isTransportFailure } from './providers/failures'
import { isOutOfUsage } from './usageErrors'
import { requestLimit } from './providers/requestLimits'

/** Store categories and model ids only. Provider error bodies can contain secrets. */
export function observeAccessFailure(id: string, model: string, error: unknown, now = Date.now()): void {
  if (isSubscriptionCheckFailure(error) || isTransportFailure(error)) return
  const status = failureStatus(error)
  const capacity = requestLimit(error)
  const detail = error as { scope?: string; resetAt?: number; retryAt?: number } | null
  const auth = status === 401 || isAccountAccessFailure(error)
  const state = capacity ? 'request-limit' : auth ? 'auth' : isOutOfUsage(error) ? 'quota' : status === 403 ? 'restricted' : isTransient(error) ? 'cooldown' : null
  if (!state) return
  const scope = auth || detail?.scope === 'account' ? 'account' : 'model'
  const reset = detail?.retryAt ?? detail?.resetAt
  const retryAt = typeof reset === 'number' && Number.isFinite(reset) && reset > now ? reset : state === 'cooldown' ? now + 60_000 : undefined
  const mark: AccessObservation = { state, scope, model, checkedAt: now, ...(retryAt ? { retryAt } : {}) }
  const all = loadPersistedSettings().accessObservations ?? {}
  const previous = all[id]
  const observations = (previous?.observations ?? []).filter(item => !(item.scope === scope && (scope === 'account' || item.model === model)))
  savePersistedSettings({ accessObservations: { ...all, [id]: { ...previous, observations: [...observations, mark].slice(-40) } } })
}

export function observeAccessSuccess(id: string, model: string, now = Date.now()): void {
  const all = loadPersistedSettings().accessObservations ?? {}
  const previous = all[id]
  const observations = (previous?.observations ?? []).filter(item => item.scope !== 'account' && item.model !== model)
  // Every reply lands here; rewrite settings only when a mark clears or the
  // last-success time is a minute stale.
  if (observations.length === (previous?.observations ?? []).length && previous?.lastSuccessAt !== undefined && now - previous.lastSuccessAt < 60_000) return
  savePersistedSettings({ accessObservations: { ...all, [id]: { lastSuccessAt: now, observations } } })
}
