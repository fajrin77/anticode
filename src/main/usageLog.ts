import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { UsageByDay, UsageByModel, UsageRecord, UsageSummary } from '@shared/ipc'

/*
 * Persistent per-request usage log. Every `usage` event the agent emits is
 * appended here with real provider-reported tokens, so Settings → Usage can
 * answer "what did I spend today / this week / this month, on which model"
 * from data, not estimates. Rotation tallies and renderer localStorage only
 * keep running totals; this file keeps the timestamped rows those totals come
 * from.
 */

/** Hard cap: old rows go first, the file never grows without bound. */
const MAX_ENTRIES = 20_000
/** Rows older than this are dropped on load, whatever the count. */
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000

let memory: UsageRecord[] | null = null
let fileOverride: string | null = null

function file(): string {
  if (fileOverride !== null) return fileOverride
  return path.join(app.getPath('userData'), 'usage.jsonl')
}

/** For tests: point the log at a temp file. */
export function setUsageLogFileForTests(filePath: string | null): void {
  fileOverride = filePath
  memory = null
}

function valid(record: unknown): record is UsageRecord {
  const r = record as UsageRecord | null
  return (
    r !== null &&
    typeof r === 'object' &&
    typeof r.ts === 'number' &&
    Number.isFinite(r.ts) &&
    typeof r.sessionId === 'string' &&
    typeof r.runId === 'string' &&
    typeof r.provider === 'string' &&
    typeof r.providerLabel === 'string' &&
    typeof r.model === 'string' &&
    typeof r.inputTokens === 'number' &&
    typeof r.outputTokens === 'number' &&
    typeof r.cachedTokens === 'number' &&
    (r.costUsd === null || typeof r.costUsd === 'number') &&
    typeof r.estimated === 'boolean' &&
    typeof r.subagent === 'boolean'
  )
}

function load(): UsageRecord[] {
  if (memory !== null) return memory
  let rows: UsageRecord[] = []
  try {
    if (existsSync(file())) {
      const text = readFileSync(file(), 'utf8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const parsed: unknown = JSON.parse(trimmed)
          if (valid(parsed)) rows.push(parsed)
        } catch {
          // One corrupt line must not lose the whole log.
        }
      }
    }
  } catch {
    rows = []
  }
  const cutoff = Date.now() - RETENTION_MS
  rows = rows.filter((row) => row.ts >= cutoff)
  if (rows.length > MAX_ENTRIES) rows = rows.slice(-MAX_ENTRIES)
  memory = rows
  return memory
}

function persist(): void {
  if (memory === null) return
  try {
    mkdirSync(path.dirname(file()), { recursive: true })
    writeFileSync(`${file()}.tmp`, memory.map((row) => JSON.stringify(row)).join('\n') + (memory.length > 0 ? '\n' : ''), { mode: 0o600 })
    renameSync(`${file()}.tmp`, file())
  } catch {
    // Persistence is best-effort; in-memory rows still answer queries.
  }
}

/** Appends one priced request. Called from the bus, where every run passes. */
export function recordUsage(record: UsageRecord): void {
  const rows = load()
  rows.push(record)
  if (rows.length > MAX_ENTRIES) rows.splice(0, rows.length - MAX_ENTRIES)
  // Append fast; a full rewrite happens on prune/clear only.
  try {
    mkdirSync(path.dirname(file()), { recursive: true })
    appendFileSync(file(), `${JSON.stringify(record)}\n`, { mode: 0o600 })
  } catch {
    // Best-effort; the in-memory copy still counts until restart.
  }
  // Opportunistically drop rows past retention without rewriting every turn:
  // only a full rewrite prunes, and only when the log is large and old.
  if (rows.length >= MAX_ENTRIES) persist()
}

/** Drops rows past retention; answers how many went. */
export function pruneUsage(): number {
  const rows = load()
  const cutoff = Date.now() - RETENTION_MS
  const kept = rows.filter((row) => row.ts >= cutoff)
  const removed = rows.length - kept.length
  if (removed > 0) {
    memory = kept
    persist()
  }
  return removed
}

/** Drops the whole log; answers how many entries were removed. */
export function clearUsage(): number {
  const rows = load()
  const removed = rows.length
  memory = []
  persist()
  return removed
}

function dayKey(ts: number): string {
  const date = new Date(ts)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Aggregates the log over the last `rangeMs` (null is everything kept).
 * Totals, per-day (oldest first, calendar-local), and per-model (costliest
 * first) splits come from the same rows, so the cards and the tables agree.
 */
export function summarizeUsage(rangeMs: number | null): UsageSummary {
  const cutoff = rangeMs === null || !Number.isFinite(rangeMs) || rangeMs <= 0 ? null : Date.now() - rangeMs
  const rows = load().filter((row) => cutoff === null || row.ts >= cutoff)
  const byDay = new Map<string, UsageByDay>()
  const byModel = new Map<string, UsageByModel>()
  let requests = 0
  let inputTokens = 0
  let cachedTokens = 0
  let outputTokens = 0
  let costUsd = 0
  let costPartial = false
  let since: number | null = null

  for (const row of rows) {
    requests += 1
    inputTokens += row.inputTokens
    cachedTokens += row.cachedTokens
    outputTokens += row.outputTokens
    if (typeof row.costUsd === 'number') costUsd += row.costUsd
    else costPartial = true
    if (since === null || row.ts < since) since = row.ts

    const day = dayKey(row.ts)
    const dayEntry = byDay.get(day) ?? { day, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
    dayEntry.requests += 1
    dayEntry.inputTokens += row.inputTokens
    dayEntry.outputTokens += row.outputTokens
    if (typeof row.costUsd === 'number') dayEntry.costUsd += row.costUsd
    byDay.set(day, dayEntry)

    const key = `${row.provider}\n${row.model}`
    const modelEntry = byModel.get(key) ?? {
      provider: row.providerLabel,
      model: row.model,
      requests: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costPartial: false
    }
    modelEntry.requests += 1
    modelEntry.inputTokens += row.inputTokens
    modelEntry.cachedTokens += row.cachedTokens
    modelEntry.outputTokens += row.outputTokens
    if (typeof row.costUsd === 'number') modelEntry.costUsd += row.costUsd
    else modelEntry.costPartial = true
    byModel.set(key, modelEntry)
  }

  return {
    requests,
    inputTokens,
    cachedTokens,
    outputTokens,
    costUsd,
    costPartial,
    since,
    byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    byModel: [...byModel.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
  }
}

/** Newest first, capped by `limit`. */
export function recentUsage(limit: number): UsageRecord[] {
  const capped = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 50
  return load().slice(-capped).reverse()
}
