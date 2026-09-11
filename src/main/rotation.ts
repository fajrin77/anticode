import { randomUUID } from 'node:crypto'
import type { OutOfUsage, RotationEntry, RotationGroup } from '@shared/ipc'
import type { LLMProvider, Usage } from './providers/types'
import { loadPersistedSettings, savePersistedSettings } from './settings'

/**
 * Rotate usage: several models — usually the same gateway under different
 * accounts, or different gateways — share the token load of every session set
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
 * Groups name parts of the pool — models for code, for media, for reasoning.
 * The group in use is what every session rotates over; with none in use, the
 * whole pool is. A group only ever holds pool models: one it names joins the
 * pool, and one that leaves the pool leaves every group.
 *
 * A group can also take a provider whole — "nvidia", rotating over every
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
/** Told when something changes on its own, mid-run — a quota running out. */
let changeSink: (() => void) | null = null

export function rotationKey(entry: RotationEntry): string {
  return `${entry.provider}\n${entry.model}`
}

/** Called once by ipc registration, so every viewer hears of it at once. */
export function setRotationChangeSink(sink: () => void): void {
  changeSink = sink
}

function load(): RotationEntry[] {
  if (entries !== null) return entries
  const saved = loadPersistedSettings().rotation
  entries = Array.isArray(saved?.entries)
    ? clean(saved.entries)
    : []
  enabled = saved?.enabled === true
  for (const [key, tally] of Object.entries(saved?.usage ?? {})) {
    if (typeof tally?.inputTokens === 'number' && typeof tally.outputTokens === 'number') {
      usage.set(key, { inputTokens: tally.inputTokens, outputTokens: tally.outputTokens })
    }
  }
  const inPool = new Set(entries.map(rotationKey))
  groups = cleanGroups(Array.isArray(saved?.groups) ? saved.groups : [], inPool, [])
  activeGroup = groups.some((group) => group.id === saved?.group) ? (saved?.group ?? null) : null
  for (const [key, mark] of Object.entries(saved?.outOfUsage ?? {})) {
    if (inPool.has(key) && typeof mark?.since === 'number' && typeof mark.reason === 'string') {
      exhausted.set(key, { since: mark.since, reason: mark.reason })
    }
  }
  return entries
}

/**
 * Named, each id once, and holding only pool models. A group made just now
 * gets its id here. A group left with no models stays: it is being filled.
 * One sent without `providers` — an older client — keeps the links it had,
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
    const model = typeof (item as RotationEntry | null)?.model === 'string' ? (item as RotationEntry).model.trim() : ''
    if (provider === '' || model === '') continue
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
export function activeRotationEntries(): RotationEntry[] {
  const list = load()
  const group = groups.find((item) => item.id === activeGroup)
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
 * one already there, not at zero — otherwise it would take every prompt until
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
    if (!existing.has(key)) usage.set(key, baseline === null ? { inputTokens: 0, outputTokens: 0 } : { ...baseline })
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
export function coolDown(entry: RotationEntry, now = Date.now()): void {
  cooling.set(rotationKey(entry), now + COOL_DOWN_MS)
}

export function coolingUntil(entry: RotationEntry, now = Date.now()): number | null {
  const until = cooling.get(rotationKey(entry))
  if (until === undefined) return null
  if (until <= now) {
    cooling.delete(rotationKey(entry))
    return null
  }
  return until
}

export function outOfUsage(entry: RotationEntry): OutOfUsage | null {
  load()
  const mark = exhausted.get(rotationKey(entry))
  return mark === undefined ? null : { ...mark }
}

/**
 * Spent credit and exhausted plans, as opposed to a per-minute rate limit:
 * 402 Payment Required, or the words providers use for it — OpenAI's
 * insufficient_quota, Moonshot's exceeded_current_quota, Anthropic's credit
 * balance, OpenRouter's and DeepSeek's insufficient credits or balance, Z.ai's
 * usage limit. A plain "rate limit reached" is not one: that passes in a minute.
 */
const SPENT =
  /insufficient[_ -]?(quota|credits?|balance|funds)|exceeded[_ ](your[_ ])?(current[_ ])?quota|quota[_ ](exceeded|exhausted)|out of (credits?|quota|tokens)|credit balance|no credits? (left|remaining)|usage limit|billing|余额不足|额度/i

export function isOutOfUsage(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const record = error as { status?: unknown; code?: unknown; type?: unknown; message?: unknown; error?: unknown }
  if (record.status === 402) return true
  const inner = (record.error ?? null) as { code?: unknown; type?: unknown; message?: unknown } | null
  const said = [record.code, record.type, record.message, inner?.code, inner?.type, inner?.message]
    .filter((part) => typeof part === 'string' || typeof part === 'number')
    .join(' ')
  return SPENT.test(said)
}

/** Marks a pool model whose quota ran out; one outside the pool is not tracked. */
export function markOutOfUsage(entry: RotationEntry, error: unknown, now = Date.now()): void {
  const key = rotationKey(entry)
  if (!load().some((item) => rotationKey(item) === key)) return
  const message = error instanceof Error ? error.message : String(error)
  const reason = message.replace(/\s+/g, ' ').trim().slice(0, 160)
  exhausted.set(key, { since: exhausted.get(key)?.since ?? now, reason })
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
 * even the resting ones — they are only worth trying once nothing else is
 * left. Then resting ones, then the ones fewer running sessions are on (so
 * prompts sent together spread out before any of them has reported a token),
 * then the fewest tokens, then pool order.
 */
export function rankRotation(options: {
  ready: (entry: RotationEntry) => boolean
  busy: (entry: RotationEntry) => number
  exclude?: Set<string>
  now?: number
}): RotationEntry[] {
  const now = options.now ?? Date.now()
  return activeRotationEntries()
    .map((entry, index) => ({
      entry,
      index,
      spentOut: exhausted.has(rotationKey(entry)) ? 1 : 0,
      resting: coolingUntil(entry, now) !== null ? 1 : 0,
      busy: options.busy(entry),
      spent: total(usage.get(rotationKey(entry)) ?? { inputTokens: 0, outputTokens: 0 })
    }))
    .filter(({ entry }) => options.ready(entry) && !(options.exclude?.has(rotationKey(entry)) ?? false))
    .sort((a, b) =>
      a.spentOut - b.spentOut || a.resting - b.resting || a.busy - b.busy || a.spent - b.spent || a.index - b.index)
    .map(({ entry }) => entry)
}

/**
 * Every provider a session talks to goes through this, so the tokens it
 * spends land on its pool entry when it has one — and a quota that runs out
 * is marked on it, whichever session found out.
 */
export function countedProvider(entry: RotationEntry, inner: LLMProvider): LLMProvider {
  return {
    name: inner.name,
    id: entry.provider,
    model: inner.model,
    async *chat(params) {
      try {
        for await (const event of inner.chat(params)) {
          if (event.type === 'response') {
            recordRotationUsage(entry, event.response.usage)
            markUsable(entry)
          }
          yield event
        }
      } catch (error) {
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
  groups = []
  activeGroup = null
  usage.clear()
  cooling.clear()
  exhausted.clear()
}
