import { createHash } from 'node:crypto'
import { ProviderRequestError } from '../providers/requestError'
import { CLAUDE_CODE_HEADERS } from '../providers/anthropic'
import { readAuthTokens, updateAuthTokens } from './store'
import type { AuthTokens } from './types'

export const CLAUDE_ACCESS_FRESH_MS = 5 * 60_000
export const CLAUDE_ACCESS_MAX_AGE_MS = 15 * 60_000
export interface ClaudeAccessSnapshot { profile: unknown; usage: unknown; checkedAt?: number; stale?: boolean }
interface CachedAccess { value?: ClaudeAccessSnapshot; retryAt: number; error?: Error; pending?: Promise<ClaudeAccessSnapshot> }
const snapshots = new Map<string, CachedAccess>()
const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex')

export class ClaudeAccessCheckError extends ProviderRequestError {
  readonly operation = 'subscription-check'
}

/** A caller may cancel its wait without cancelling another view's shared check. */
async function waitForAccess(promise: Promise<ClaudeAccessSnapshot>, signal?: AbortSignal): Promise<ClaudeAccessSnapshot> {
  if (!signal) return promise
  signal.throwIfAborted()
  let abort: () => void = () => {}
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason ?? new Error('Cancelled')); signal.addEventListener('abort', abort, { once: true }) })
  try { return await Promise.race([promise, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function parseClaudeAccess(profile: unknown, usage: unknown): { plan?: string; subscribed: boolean; extraUsageEnabled: boolean | null } {
  const account = object(object(profile).account)
  const org = object(object(profile).organization)
  const extra = object(object(usage).extra_usage).is_enabled
  const plan = account.has_claude_max === true ? 'max' : account.has_claude_pro === true ? 'pro' : typeof org.organization_type === 'string' ? org.organization_type : undefined
  const active = org.subscription_status === 'active'
  return { ...(plan ? { plan } : {}), subscribed: active && (account.has_claude_max === true || account.has_claude_pro === true || ['claude_team', 'claude_enterprise'].includes(String(org.organization_type))), extraUsageEnabled: typeof extra === 'boolean' ? extra : null }
}

export async function readClaudeAccess(tokens: AuthTokens, signal?: AbortSignal): Promise<ClaudeAccessSnapshot> {
  signal?.throwIfAborted()
  const key = tokenHash(tokens.accessToken)
  let entry = snapshots.get(key)
  const now = Date.now()
  if (entry?.value && now - (entry.value.checkedAt ?? 0) < CLAUDE_ACCESS_FRESH_MS) return entry.value
  if (entry?.pending) return waitForAccess(entry.pending, signal)
  if (entry && entry.retryAt > now) {
    if (entry.value && now - (entry.value.checkedAt ?? 0) < CLAUDE_ACCESS_MAX_AGE_MS) return { ...entry.value, stale: true }
    throw entry.error
  }
  if (!entry) {
    if (snapshots.size >= 32) for (const [oldKey, old] of snapshots) { if (!old.pending) { snapshots.delete(oldKey); break } }
    entry = { retryAt: 0 }; snapshots.set(key, entry)
  }
  const current = entry
  const get = async (path: string): Promise<unknown> => {
    let response: Response
    try {
      response = await fetch(`https://api.anthropic.com/api/oauth/${path}`, {
        headers: { ...CLAUDE_CODE_HEADERS, authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000)
      })
    } catch { throw new ClaudeAccessCheckError('Claude subscription verification is temporarily unavailable. Previously verified access is retained only within its validation period.', 503, 'account', undefined, Date.now() + 60_000) }
    if (!response.ok) {
      const raw = response.headers.get('retry-after')
      const seconds = raw === null ? NaN : Number(raw)
      const retryAt = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : raw && Number.isFinite(Date.parse(raw)) ? Date.parse(raw) : Date.now() + 60_000
      throw new ClaudeAccessCheckError(`Claude subscription verification unavailable (HTTP ${response.status}). This is a verification service error, not confirmation that inference quota is exhausted.`, response.status, 'account', undefined, retryAt)
    }
    return response.json()
  }
  const request = (async (): Promise<ClaudeAccessSnapshot> => {
    try {
      const [profile, usage] = await Promise.all([get('profile'), get('usage')])
      const value = { profile, usage, checkedAt: Date.now() }
      current.value = value; current.retryAt = 0; delete current.error
      return value
    } catch (failure) {
      const error = failure instanceof Error ? failure : new ClaudeAccessCheckError('Claude subscription response unavailable.', 503)
      current.error = error; current.retryAt = (error as ProviderRequestError).retryAt ?? Date.now() + 60_000
      const status = (error as ProviderRequestError).status
      if ((status === 429 || status >= 500) && current.value && Date.now() - (current.value.checkedAt ?? 0) < CLAUDE_ACCESS_MAX_AGE_MS) return { ...current.value, stale: true }
      // Authentication/authorization refusals revoke cached evidence immediately.
      if (status === 401 || status === 403) delete current.value
      throw error
    } finally { delete current.pending }
  })()
  current.pending = request
  return waitForAccess(request, signal)
}

/** OAuth only; no Console key or alternate billing endpoint is substituted. */
export async function checkClaudeSubscription(id: string, tokens: AuthTokens, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  let raw: ClaudeAccessSnapshot
  try { raw = await readClaudeAccess(tokens, signal) }
  catch (error) {
    signal?.throwIfAborted()
    const status = (error as ProviderRequestError).status
    const meta = readAuthTokens(id)?.meta ?? tokens.meta
    const at = Number(meta?.claudeAccessCheckedAt)
    // A restart does not erase a recent positive decision. Token rotation,
    // expired evidence, and explicit revocations never inherit this lease.
    if ((status === 429 || status >= 500) && meta?.claudeAccessReady === 'true' && meta.claudeAccessTokenHash === tokenHash(tokens.accessToken) && Number.isFinite(at) && at <= Date.now() && Date.now() - at < CLAUDE_ACCESS_MAX_AGE_MS) return
    throw error
  }
  signal?.throwIfAborted()
  const access = recordClaudeAccess(id, tokens, raw)
  if (!access.subscribed) throw new ProviderRequestError('Claude did not confirm an active subscription. No inference request was sent; no paid API fallback is used.', 403)
  if (access.extraUsageEnabled !== false) throw new ProviderRequestError('Turn off Extra usage in Claude account settings before using this subscription connection. Anticode cannot safely confirm subscription-only usage while Extra usage is enabled or unknown.', 403)

}

export function recordClaudeAccess(id: string, tokens: AuthTokens, raw: ClaudeAccessSnapshot): ReturnType<typeof parseClaudeAccess> {
  const access = parseClaudeAccess(raw.profile, raw.usage)
  const allowed = access.subscribed && access.extraUsageEnabled === false
  // The official Claude Code engine receives this OAuth token only after this
  // check. API keys and alternate billing endpoints are excluded from its env.
  const current = readAuthTokens(id)
  const checkedAt = String(raw.checkedAt ?? Date.now())
  if (current?.accessToken === tokens.accessToken && (current.meta?.claudeAccessCheckedAt !== checkedAt || current.meta?.claudeAccessReady !== String(allowed))) updateAuthTokens(id, { ...current, meta: { ...current.meta, claudeAccessReady: String(allowed), claudePlan: access.plan ?? '', claudeAccessCheckedAt: checkedAt, claudeAccessTokenHash: tokenHash(tokens.accessToken) } })
  return access
}

export function resetClaudeAccessForTests(): void { snapshots.clear() }
