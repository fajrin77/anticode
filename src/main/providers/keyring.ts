import { observeAccessFailure, observeAccessSuccess } from '../accessLedger'
import { isOutOfUsage } from '../usageErrors'
import { createHash } from 'node:crypto'
import { accountRoutingTokens, recordAccountUsage } from '../auth/sharing'
import { loadPersistedSettings, savePersistedSettings } from '../settings'
import { ProviderRequestError } from './requestError'
import { canFailOver, failureStatus, isAccountAccessFailure } from './failures'
import { requestLimit } from './requestLimits'
import type { ChatParams, LLMProvider, ProviderEvent } from './types'
const busy = new Map<string, number>()

export function providerKeyId(id: string, key: string): string { return `apikey:${id}:${createHash('sha256').update(key).digest('hex').slice(0, 24)}` }

/** Track keys separately without assuming they belong to different quota accounts. */
export function keyringProvider(id: string, model: string, keys: string[], create: (key: string) => LLMProvider): LLMProvider {
  const unique = [...new Set(keys.filter(Boolean))]
  if (unique.length === 0) return create('')
  const primary = create(unique[0]!)
  const entries = unique.map(key => ({ key, id: providerKeyId(id, key) }))
  return {
    id, name: primary.name, model: primary.model || model,
    ...(primary.generateImage ? { generateImage: (params: import('./types').ImageGenerationParams) => primary.generateImage!(params) } : {}),
    async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
      const tried = new Set<string>()
      let failure: unknown
      let largestInputFailure: unknown
      while (tried.size < entries.length) {
        const cooldowns = loadPersistedSettings().providerKeyCooldowns ?? {}
        // A 401 is the key's own fault; anything else is about this model only,
        // so a paid model out of credit does not bench the key for a free one.
        const entry = entries.filter(item => !tried.has(item.id) && Math.max(cooldowns[item.id] ?? 0, cooldowns[`${item.id}:${model}`] ?? 0) <= Date.now())
          .sort((a,b) => (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0) || accountRoutingTokens(a.id) - accountRoutingTokens(b.id))[0]
        if (!entry) break
        tried.add(entry.id)
        busy.set(entry.id, (busy.get(entry.id) ?? 0) + 1)
        let produced = false
        try {
          for await (const event of create(entry.key).chat(params)) {
            produced ||= event.type === 'response' || event.text.length > 0
            if (event.type === 'response') {
              recordAccountUsage(entry.id, event.response.usage.inputTokens, event.response.usage.outputTokens)
              observeAccessSuccess(entry.id, model)
            }
            yield event
          }
          return
        } catch (error) {
          if (!params.signal.aborted) observeAccessFailure(entry.id, model, error)
          failure = error
          const status = failureStatus(error)
          const accountFailure = status === 401 || isAccountAccessFailure(error)
          const capacity = requestLimit(error)
          if (params.signal.aborted || (!capacity && !canFailOver(error))) throw error
          // Another key may have a larger request allowance. A smaller next
          // request must still be able to use this key immediately.
          if (capacity) {
            if (produced) throw error
            if (capacity.kind === 'input' && (capacity.limitTokens ?? 0) > (requestLimit(largestInputFailure)?.limitTokens ?? 0)) largestInputFailure = error
            continue
          }
          const detail = error as { resetAt?: number; retryAt?: number; scope?: string }
          const resetAt = detail.retryAt ?? detail.resetAt
          // With one key, a dropped socket is not evidence that the key is
          // unusable. Let the bounded request retry / explicit Continue try
          // again; quota, auth, and explicit provider cooldowns still apply.
          if (unique.length === 1 && !accountFailure && status !== 429 && !isOutOfUsage(error) && resetAt === undefined) throw error
          const until = typeof resetAt === 'number' && Number.isFinite(resetAt) && resetAt > Date.now() ? resetAt : Date.now() + (accountFailure || isOutOfUsage(error) ? 15 * 60000 : 60000)
          savePersistedSettings({providerKeyCooldowns:{...loadPersistedSettings().providerKeyCooldowns,[accountFailure || detail.scope === 'account' ? entry.id : `${entry.id}:${model}`]:until}})
          // A partial answer cannot be replayed, but Continue must still skip
          // the failed key instead of hitting its limit again.
          if (produced) throw error
        } finally { const remaining = Math.max(0, (busy.get(entry.id) ?? 1) - 1); if (remaining) busy.set(entry.id, remaining); else busy.delete(entry.id) }
      }
      if (failure !== undefined) throw requestLimit(failure)?.kind === 'input' ? largestInputFailure ?? failure : failure
      const cooldowns = loadPersistedSettings().providerKeyCooldowns ?? {}
      const back = Math.min(...entries.map(item => Math.max(cooldowns[item.id] ?? 0, cooldowns[`${item.id}:${model}`] ?? 0)))
      const minutes = Math.max(1, Math.ceil((back - Date.now()) / 60000))
      throw new ProviderRequestError(`All API keys for ${model} are cooling down after earlier errors; the first is usable again in about ${minutes} min. Pick another model or add another key.`, 429)
    }
  }
}
