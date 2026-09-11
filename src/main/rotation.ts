import type { RotationEntry } from '@shared/ipc'
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
 */

/** How long an entry that failed stays at the back of the queue. */
export const COOL_DOWN_MS = 60_000

interface Tally {
  inputTokens: number
  outputTokens: number
}

let entries: RotationEntry[] | null = null
const usage = new Map<string, Tally>()
const cooling = new Map<string, number>()

export function rotationKey(entry: RotationEntry): string {
  return `${entry.provider}\n${entry.model}`
}

function load(): RotationEntry[] {
  if (entries !== null) return entries
  const saved = loadPersistedSettings().rotation
  entries = Array.isArray(saved?.entries)
    ? clean(saved.entries)
    : []
  for (const [key, tally] of Object.entries(saved?.usage ?? {})) {
    if (typeof tally?.inputTokens === 'number' && typeof tally.outputTokens === 'number') {
      usage.set(key, { inputTokens: tally.inputTokens, outputTokens: tally.outputTokens })
    }
  }
  return entries
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
      entries: list,
      usage: Object.fromEntries([...usage].filter(([key]) => keys.has(key)))
    }
  })
}

export function rotationEntries(): RotationEntry[] {
  return [...load()]
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
  for (const key of [...usage.keys()]) if (!list.some((entry) => rotationKey(entry) === key)) usage.delete(key)
  entries = list
  persist()
  return [...list]
}

/** Drops every entry of a provider that is gone. */
export function forgetRotationProvider(provider: string): void {
  const list = load()
  if (!list.some((entry) => entry.provider === provider)) return
  setRotationEntries(list.filter((entry) => entry.provider !== provider))
}

export function resetRotationUsage(): void {
  usage.clear()
  cooling.clear()
  persist()
}

export function rotationUsage(entry: RotationEntry): Tally {
  return { ...(usage.get(rotationKey(entry)) ?? { inputTokens: 0, outputTokens: 0 }) }
}

/** Counted only for models in the pool; anything else has nothing to balance. */
export function recordRotationUsage(entry: RotationEntry, spent: Usage): void {
  const key = rotationKey(entry)
  if (!load().some((item) => rotationKey(item) === key)) return
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

function total(tally: Tally): number {
  return tally.inputTokens + tally.outputTokens
}

/**
 * The pool, best first: entries that are resting go last, then the ones fewer
 * running sessions are on (so prompts sent together spread out before any of
 * them has reported a token), then the fewest tokens, then pool order.
 */
export function rankRotation(options: {
  ready: (entry: RotationEntry) => boolean
  busy: (entry: RotationEntry) => number
  exclude?: Set<string>
  now?: number
}): RotationEntry[] {
  const now = options.now ?? Date.now()
  const list = load()
  return list
    .map((entry, index) => ({
      entry,
      index,
      resting: coolingUntil(entry, now) !== null ? 1 : 0,
      busy: options.busy(entry),
      spent: total(usage.get(rotationKey(entry)) ?? { inputTokens: 0, outputTokens: 0 })
    }))
    .filter(({ entry }) => options.ready(entry) && !(options.exclude?.has(rotationKey(entry)) ?? false))
    .sort((a, b) => a.resting - b.resting || a.busy - b.busy || a.spent - b.spent || a.index - b.index)
    .map(({ entry }) => entry)
}

/**
 * Every provider a session talks to goes through this, so the tokens it
 * spends land on its pool entry when it has one.
 */
export function countedProvider(entry: RotationEntry, inner: LLMProvider): LLMProvider {
  return {
    name: inner.name,
    model: inner.model,
    async *chat(params) {
      for await (const event of inner.chat(params)) {
        if (event.type === 'response') recordRotationUsage(entry, event.response.usage)
        yield event
      }
    }
  }
}

/** For tests: forget everything loaded. */
export function resetRotationForTests(): void {
  entries = null
  usage.clear()
  cooling.clear()
}
