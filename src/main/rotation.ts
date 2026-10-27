import { isSubscriptionCheckFailure } from './providers/requestError'
import { observeAccessFailure, observeAccessSuccess } from './accessLedger'
import { recordAccountUsage } from './auth/sharing'
import { randomUUID } from 'node:crypto'
import { canonicalClinepassModel } from './providers/clinepass'
import type { OutOfUsage, RotationEntry, RotationGroup } from '@shared/ipc'
import type { LLMProvider, Usage } from './providers/types'
import { loadPersistedSettings, savePersistedSettings } from './settings'
import { isOutOfUsage } from './usageErrors'
import { canFailOver, isTransportFailure } from './providers/failures'
import { modelIsBatchOnly } from '@shared/ipc'
import { isRetiredRoute } from './providers/routeError'
import { markRetiredRoute, unavailableRoute } from './routeAvailability'
import { safeProviderErrorMessage } from './providers/errorMessage'

export { isOutOfUsage }

/**
 * Rotate usage: several models, usually the same gateway under different
 * accounts, or different gateways, share the token load of every session set
 * to rotate. A session stays on an entry for a couple of prompts (runtime's
 * PROMPTS_PER_MODEL), then moves to the one that has used the fewest tokens,
 * so no one account's quota is drained while the others sit idle.
 *
 * Tokens are counted for every session, not only rotating ones: a session
 * pinned to a pooled model loads that account just the same, and balancing
 * that ignored it would keep sending rotating prompts to the busiest one.
 *
 * It runs only while switched on in Settings. Off, the pool is just the
 * models the composer offers: nothing rotates and nothing is counted.
 *
 * Groups name parts of the pool, models for code, for media, for reasoning.
 * The group in use is what every session rotates over; with none in use, the
 * whole pool is. A group only ever holds pool models: one it names joins the
 * pool, and one that leaves the pool leaves every group.
 *
 * A group can also take a provider whole, "nvidia", rotating over every
 * nvidia model switched on. It is a link, not a copy: a model switched on for
 * that provider later joins the group, one switched off leaves it.
 */

/** How long an entry that failed stays at the back of the queue. */
export const COOL_DOWN_MS = 60_000

/** Longest group name kept; the composer chip has little room for it. */
const GROUP_NAME_MAX = 40

interface Tally {
  inputTokens: number
  outputTokens: number
}

let entries: RotationEntry[] | null = null
let enabled = false
let plansOnly = false
/** As kept: hand-picked entries only, never ones a provider link covers. */
interface StoredGroup {
  id: string
  name: string
  entries: RotationEntry[]
  providers: string[]
}

let groups: StoredGroup[] = []
let activeGroup: string | null = null
const usage = new Map<string, Tally>()
const cooling = new Map<string, number>()
const exhausted = new Map<string, OutOfUsage>()
/** Told when something changes on its own, mid-run, a quota running out. */
let changeSink: (() => void) | null = null

export function rotationKey(entry: RotationEntry): string {
  const model = entry.provider === 'clinepass' ? canonicalClinepassModel(entry.model) : entry.model
  return `${entry.provider}\n${model}`
}

/** Called once by ipc registration, so every viewer hears of it at once. */
export function setRotationChangeSink(sink: () => void): void {
  changeSink = sink
}

function canonicalStoredKey(key: string): string {
  const separator = key.indexOf('\n')
  return separator < 0 ? key : rotationKey({ provider: key.slice(0, separator), model: key.slice(separator + 1) })
}

function load(): RotationEntry[] {
  if (entries !== null) return entries
  const saved = loadPersistedSettings().rotation
  entries = Array.isArray(saved?.entries)
    ? clean(saved.entries)
    : []
  enabled = saved?.enabled === true
  plansOnly = saved?.subscriptionOnly === true
  for (const [key, tally] of Object.entries(saved?.usage ?? {})) {
    if (typeof tally?.inputTokens === 'number' && typeof tally.outputTokens === 'number') {
      const canonical = canonicalStoredKey(key)
      const previous = usage.get(canonical)
      usage.set(canonical, {
        inputTokens: (previous?.inputTokens ?? 0) + tally.inputTokens,
        outputTokens: (previous?.outputTokens ?? 0) + tally.outputTokens
      })
    }
  }
  const inPool = new Set(entries.map(rotationKey))
  groups = cleanGroups(Array.isArray(saved?.groups) ? saved.groups : [], inPool, [])
  activeGroup = groups.some((group) => group.id === saved?.group) ? (saved?.group ?? null) : null
  for (const [storedKey, mark] of Object.entries(saved?.outOfUsage ?? {})) {
    const key = canonicalStoredKey(storedKey)
    if (inPool.has(key) && typeof mark?.since === 'number' && typeof mark.reason === 'string') {
      exhausted.set(key, { since: mark.since, reason: mark.reason,
        ...(typeof mark.resetAt === 'number' && Number.isFinite(mark.resetAt) ? { resetAt: mark.resetAt } : {}),
        ...(mark.scope === 'account' ? { scope: 'account' } : {}) })
    }
  }
  return entries
}

/**
 * Named, each id once, and holding only pool models. A group made just now
 * gets its id here. A group left with no models stays: it is being filled.
 * One sent without `providers`, an older client, keeps the links it had,
 * and entries a link covers are dropped: the link brings them in anyway.
 */
function cleanGroups(list: unknown[], inPool: Set<string>, previous: StoredGroup[]): StoredGroup[] {
  const ids = new Set<string>()
  const kept: StoredGroup[] = []
  for (const item of list) {
    const raw = item as { id?: unknown; name?: unknown; entries?: unknown; providers?: unknown } | null
    const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, GROUP_NAME_MAX) : ''
    if (name === '') continue
    let id = typeof raw?.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : randomUUID()
    if (ids.has(id)) id = randomUUID()
    ids.add(id)
    const providers = Array.isArray(raw?.providers)
      ? [...new Set(raw.providers.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter((value) => value !== ''))]
      : (previous.find((group) => group.id === id)?.providers ?? [])
    const members = clean(Array.isArray(raw?.entries) ? raw.entries : [])
      .filter((entry) => inPool.has(rotationKey(entry)) && !providers.includes(entry.provider))
    kept.push({ id, name, entries: members, providers: [...providers] })
  }
  return kept
}

/** What a group rotates over: its hand-picked models, then its providers' ones, pool order. */
function membersOf(group: StoredGroup): RotationEntry[] {
  const linked = load().filter((entry) => group.providers.includes(entry.provider))
  return [...group.entries, ...linked].map((entry) => ({ ...entry }))
}

/** Well-formed, trimmed, and each provider+model once, in the order given. */
function clean(list: unknown[]): RotationEntry[] {
  const seen = new Set<string>()
  const kept: RotationEntry[] = []
  for (const item of list) {
    const provider = typeof (item as RotationEntry | null)?.provider === 'string' ? (item as RotationEntry).provider.trim() : ''
    const rawModel = typeof (item as RotationEntry | null)?.model === 'string' ? (item as RotationEntry).model.trim() : ''
    const model = provider === 'clinepass' ? canonicalClinepassModel(rawModel) : rawModel
    if (provider === '' || model === '' || modelIsBatchOnly(model)) continue
    const entry = { provider, model }
    if (seen.has(rotationKey(entry))) continue
    seen.add(rotationKey(entry))
    kept.push(entry)
  }
  return kept
}

function persist(): void {
  const list = load()
  const keys = new Set(list.map(rotationKey))
  savePersistedSettings({
    rotation: {
      enabled,
      subscriptionOnly: plansOnly,
      entries: list,
      usage: Object.fromEntries([...usage].filter(([key]) => keys.has(key))),
      groups,
      group: activeGroup,
      outOfUsage: Object.fromEntries([...exhausted].filter(([key]) => keys.has(key)))
    }
  })
}

export function rotationEntries(): RotationEntry[] {
  return [...load()]
}

export function rotationGroups(): RotationGroup[] {
  load()
  return groups.map((group): RotationGroup => ({
    id: group.id,
    name: group.name,
    entries: membersOf(group),
    providers: [...group.providers]
  }))
}

export function activeRotationGroupId(): string | null {
  load()
  return activeGroup
}

/** What sessions rotate over: the group in use, or the whole pool. */
export function activeRotationEntries(groupId?: string | null): RotationEntry[] {
  const list = load()
  const group = groups.find((item) => item.id === (groupId === undefined ? activeGroup : groupId))
  return group === undefined ? [...list] : membersOf(group)
}

/**
 * Replaces the groups. A model a group names that is not in the pool yet
 * joins it, switched on like any other. The group in use stays in use while
 * it exists; once it is gone, sessions rotate over the whole pool again.
 */
export function setRotationGroups(next: unknown[]): RotationGroup[] {
  const pool = load()
  const inPool = new Set(pool.map(rotationKey))
  const named = next.flatMap((item) => {
    const list = (item as { entries?: unknown } | null)?.entries
    return clean(Array.isArray(list) ? list : [])
  })
  const joining = named.filter((entry, index) =>
    !inPool.has(rotationKey(entry)) && named.findIndex((other) => rotationKey(other) === rotationKey(entry)) === index)
  if (joining.length > 0) setRotationEntries([...pool, ...joining])
  groups = cleanGroups(next, new Set(load().map(rotationKey)), groups)
  if (!groups.some((group) => group.id === activeGroup)) activeGroup = null
  persist()
  return rotationGroups()
}

/** Puts a group in use, or with null the whole pool. */
export function setActiveRotationGroup(id: string | null): void {
  load()
  if (id !== null && !groups.some((group) => group.id === id)) throw new Error('That group no longer exists')
  activeGroup = id
  persist()
}

export function subscriptionOnly(): boolean {
  load()
  return plansOnly
}

export function setSubscriptionOnly(on: boolean): void {
  load()
  plansOnly = on
  persist()
}

export function rotationEnabled(): boolean {
  load()
  return enabled
}

export function setRotationEnabled(on: boolean): void {
  load()
  enabled = on
  persist()
}

/**
 * Replaces the pool. An entry joining late starts level with the least-used
 * one already there, not at zero, otherwise it would take every prompt until
 * it had caught up with accounts that have been working for weeks.
 */
export function setRotationEntries(next: unknown[]): RotationEntry[] {
  const previous = load()
  const list = clean(next)
  const existing = new Set(previous.map(rotationKey))
  const baseline = previous.reduce<Tally | null>((least, entry) => {
    const tally = usage.get(rotationKey(entry)) ?? { inputTokens: 0, outputTokens: 0 }
    return least === null || total(tally) < total(least) ? tally : least
  }, null)
  for (const entry of list) {
    const key = rotationKey(entry)
    if (!existing.has(key)) usage.set(key, (entry.provider.startsWith('auth:') || entry.provider === 'clinepass') || baseline === null ? { inputTokens: 0, outputTokens: 0 } : { ...baseline })
  }
  const kept = new Set(list.map(rotationKey))
  for (const key of [...usage.keys()]) if (!kept.has(key)) usage.delete(key)
  for (const key of [...exhausted.keys()]) if (!kept.has(key)) exhausted.delete(key)
  // A model switched off leaves every group it was in.
  groups = groups.map((group) => ({ ...group, entries: group.entries.filter((entry) => kept.has(rotationKey(entry))) }))
  entries = list
  persist()
  return [...list]
}

/** Drops every entry of a provider that is gone, and every group's link to it. */
export function forgetRotationProvider(provider: string): void {
  const list = load()
  const linked = groups.some((group) => group.providers.includes(provider))
  groups = groups.map((group) => ({ ...group, providers: group.providers.filter((id) => id !== provider) }))
  if (list.some((entry) => entry.provider === provider)) setRotationEntries(list.filter((entry) => entry.provider !== provider))
  else if (linked) persist()
}

/** Counts start over, and every model gets another chance. */
export function resetRotationUsage(): void {
  usage.clear()
  cooling.clear()
  exhausted.clear()
  persist()
}

export function rotationUsage(entry: RotationEntry): Tally {
  return { ...(usage.get(rotationKey(entry)) ?? { inputTokens: 0, outputTokens: 0 }) }
}

/**
 * Counted only for models in the pool, and only while rotation is on;
 * anything else has nothing to balance.
 */
export function recordRotationUsage(entry: RotationEntry, spent: Usage): void {
  const key = rotationKey(entry)
  if (!load().some((item) => rotationKey(item) === key) || !enabled) return
  const tally = usage.get(key) ?? { inputTokens: 0, outputTokens: 0 }
  tally.inputTokens += Math.max(0, spent.inputTokens || 0)
  tally.outputTokens += Math.max(0, spent.outputTokens || 0)
  usage.set(key, tally)
  persist()
}

/** A rate limit, an empty quota, an outage: others go first for a while. */
export function coolDown(entry: RotationEntry, now = Date.now(), error?: unknown): void {
  if (isSubscriptionCheckFailure(error)) return
  // Transport outages are not evidence that a particular account is unusable.
  if (isTransportFailure(error)) return
  const detail = error as { scope?: string; retryAt?: number; resetAt?: number; status?: number } | undefined
  const key = detail?.status === 401 ? `login:${entry.provider}` : detail?.scope === 'account' ? `account:${entry.provider}` : rotationKey(entry)
  const retryAt = detail?.retryAt ?? detail?.resetAt
  const until = typeof retryAt === 'number' && Number.isFinite(retryAt) && retryAt > now ? retryAt : now + COOL_DOWN_MS
  cooling.set(key, until)
}

/** A renewed login must not inherit the old token's authentication cooldown. */
export function clearLoginCooldown(provider: string): void {
  cooling.delete(`login:${provider}`)
}

export function coolingUntil(entry: RotationEntry, now = Date.now()): number | null {
  let latest: number | null = null
  for (const key of [rotationKey(entry), `account:${entry.provider}`, `login:${entry.provider}`]) {
    const until = cooling.get(key)
    if (until === undefined) continue
    if (until <= now) cooling.delete(key)
    else latest = Math.max(latest ?? 0, until)
  }
  return latest
}

/** Quota windows providers renew on their own, used when no reset time is sent. */
const DAILY_RESET_MS = 24 * 60 * 60 * 1000
/** A card's own reported expiry is usually days away; renew sooner than that. */
const FREE_TIER_RESET_MS = 7 * 24 * 60 * 60 * 1000

/**
 * When an exhausted mark lapses without a provider reset time: daily and free
 * quotas renew, so they are retried the next day instead of staying dead. A
 * subscription account stays blocked until the provider reports its reset,
 * because its window may be weekly or monthly.
 */
function expiryOf(mark: OutOfUsage, model: string): number {
  if (mark.resetAt !== undefined) return mark.resetAt
  if (mark.scope === 'account') return Number.POSITIVE_INFINITY
  return mark.since + (/free/i.test(model) ? FREE_TIER_RESET_MS : DAILY_RESET_MS)
}

export function outOfUsage(entry: RotationEntry, now = Date.now()): OutOfUsage | null {
  load()
  let changed = false
  for (const [key, mark] of exhausted) {
    if (expiryOf(mark, key.slice(key.indexOf('\n') + 1)) <= now) {
      exhausted.delete(key)
      changed = true
    }
  }
  if (changed) persist()
  const mark = exhausted.get(rotationKey(entry)) ?? [...exhausted].find(([key, mark]) =>
    mark.scope === 'account' && key.startsWith(`${entry.provider}\n`))?.[1]
  return mark === undefined ? null : { ...mark }
}

/** Marks a pool model whose quota ran out; one outside the pool is not tracked. */
export function markOutOfUsage(entry: RotationEntry, error: unknown, now = Date.now()): void {
  const key = rotationKey(entry)
  if (!load().some((item) => rotationKey(item) === key)) return
  const message = safeProviderErrorMessage(error, entry.model)
  const reason = message.replace(/\s+/g, ' ').trim().slice(0, 160)
  const detail = error as { resetAt?: number; scope?: 'account' | 'model' } | null
  const resetAt = typeof detail?.resetAt === 'number' && Number.isFinite(detail.resetAt) && detail.resetAt > now ? detail.resetAt : undefined
  exhausted.set(key, { since: exhausted.get(key)?.since ?? now, reason,
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(detail?.scope === 'account' ? { scope: 'account' } : {}) })
  persist()
  changeSink?.()
}

/** It answered, so whatever ran out has been topped up. */
function markUsable(entry: RotationEntry): void {
  if (!exhausted.delete(rotationKey(entry))) return
  persist()
  changeSink?.()
}

function total(tally: Tally): number {
  return tally.inputTokens + tally.outputTokens
}

/**
 * The models in use, best first: ones whose quota ran out go last, behind
 * even the resting ones, they are only worth trying once nothing else is
 * left. Then resting ones, then the ones fewer running sessions are on (so
 * prompts sent together spread out before any of them has reported a token),
 * then the fewest tokens, then pool order.
 */
export function rankRotation(options: {
  ready: (entry: RotationEntry) => boolean
  busy: (entry: RotationEntry) => number
  exclude?: Set<string>
  groupId?: string | null | undefined
  now?: number
}): RotationEntry[] {
  const now = options.now ?? Date.now()
  const accountUsage = new Map<string, number>()
  load()
  for (const [key, tally] of usage) {
    const provider = key.slice(0, key.indexOf('\n'))
    if ((provider.startsWith('auth:') || provider === 'clinepass')) accountUsage.set(provider, (accountUsage.get(provider) ?? 0) + total(tally))
  }
  return activeRotationEntries(options.groupId)
    .map((entry, index) => ({
      entry,
      index,
      spentOut: outOfUsage(entry, now) !== null ? 1 : 0,
      resting: coolingUntil(entry, now) !== null ? 1 : 0,
      busy: options.busy(entry),
      spent: (entry.provider.startsWith('auth:') || entry.provider === 'clinepass') ? accountUsage.get(entry.provider) ?? 0 : total(usage.get(rotationKey(entry)) ?? { inputTokens: 0, outputTokens: 0 }),
      modelSpent: total(usage.get(rotationKey(entry)) ?? { inputTokens: 0, outputTokens: 0 })
    }))
    .filter(({ spentOut, resting }) => !plansOnly || (spentOut === 0 && resting === 0))
    .filter(({ entry }) => unavailableRoute(entry.provider, entry.model) === null)
    .filter(({ entry }) => options.ready(entry) && !(options.exclude?.has(rotationKey(entry)) ?? false))
    .sort((a, b) =>
      a.spentOut - b.spentOut || a.resting - b.resting || a.busy - b.busy || a.spent - b.spent || a.modelSpent - b.modelSpent || a.index - b.index)
    .map(({ entry }) => entry)
}

/**
 * Every provider a session talks to goes through this, so the tokens it
 * spends land on its pool entry when it has one, and a quota that runs out
 * is marked on it, whichever session found out.
 */
export function countedProvider(entry: RotationEntry, inner: LLMProvider): LLMProvider {
  return {
    name: inner.name,
    id: entry.provider,
    model: inner.model,
    ...(inner.generateImage !== undefined
      ? { generateImage: (params) => inner.generateImage!(params) }
      : {}),
    async *chat(params) {
      try {
        for await (const event of inner.chat(params)) {
          if (event.type === 'response') {
            recordAccountUsage(entry.provider, event.response.usage.inputTokens, event.response.usage.outputTokens)
            recordRotationUsage(entry, event.response.usage)
            markUsable(entry)
            observeAccessSuccess(entry.provider, entry.model)
          }
          yield event
        }
      } catch (error) {
        if (params.signal?.aborted !== true && isRetiredRoute(error)) {
          markRetiredRoute(entry.provider, entry.model)
          changeSink?.()
        }
        if (params.signal?.aborted !== true) observeAccessFailure(entry.provider, entry.model, error)
        if (params.signal?.aborted !== true && canFailOver(error)) coolDown(entry, Date.now(), error)
        if (params.signal?.aborted !== true && isOutOfUsage(error)) markOutOfUsage(entry, error)
        throw error
      }
    }
  }
}

/** For tests: forget everything loaded. */
export function resetRotationForTests(): void {
  entries = null
  enabled = false
  plansOnly = false
  groups = []
  activeGroup = null
  usage.clear()
  cooling.clear()
  exhausted.clear()
}
