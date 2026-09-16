import { setInterval, clearInterval } from 'node:timers'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { IpcChannel } from '@shared/ipc'
import { submitPrompt } from './prompts'
import { approvals } from './ipc/index'
import { getStatus, listSessionSpecs, rememberedSpec, recreateSession, createSession } from './runtime'
import type { SessionMode, ScheduleEntry, ScheduleInput } from '../shared/ipc'

/**
 * Cron for the rest of us: a schedule is "run this prompt every N" — daily
 * summaries, nightly review. One entry owns one session; when its time comes
 * the scheduler reuses the session (its model, its folder), sends the prompt
 * through the same gate a keystroke would take, and records the outcome. The
 * next run is derived from the moment a run *starts*, not when it is written,
 * so a slow run can never squeeze two fires onto one tick.
 */
type Frequency = 'daily' | 'weekly'

const TICK = 15_000

const FILE = (): string => path.join(app.getPath('userData'), 'schedules.json')
const entries = new Map<string, ScheduleEntry>()
let timer: NodeJS.Timeout | null = null
let running = false

/** One clock per entry: weekly honours its weekday, daily does not. */
function nextOccurrence(entry: ScheduleEntry, from: number): number {
  const at = new Date(from)
  at.setHours(entry.hour, entry.minute, 0, 0)
  if (entry.frequency === 'weekly' && entry.weekday !== undefined) {
    const days = (entry.weekday - at.getDay() + 7) % 7
    at.setDate(at.getDate() + days)
  }
  if (at.getTime() <= from) {
    at.setDate(at.getDate() + (entry.frequency === 'weekly' ? 7 : 1))
  }
  return at.getTime()
}

function load(): void {
  try {
    const raw = JSON.parse(readFileSync(FILE(), 'utf8')) as ScheduleEntry[]
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (isEntry(entry)) entries.set(entry.id, entry)
      }
    }
  } catch { /* first launch, or a torn file: start empty */ }
}

function isEntry(value: unknown): value is ScheduleEntry {
  const entry = value as ScheduleEntry
  return (
    typeof entry?.id === 'string' && typeof entry?.prompt === 'string' &&
    typeof entry?.sessionId === 'string' && (entry.frequency === 'daily' || entry.frequency === 'weekly')
  )
}

function persist(): void {
  try { writeFileSync(FILE(), JSON.stringify([...entries.values()], null, 2)) } catch { /* readonly disk is not fatal */ }
}

function announce(entry: ScheduleEntry): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IpcChannel.SCHEDULE_STATE, scheduleState())
  }
  // The phone follows sessions it has open; the scheduler touches them the
  // same way an agent event would, so its transcript stays honest.
  void busForward({ type: 'schedule-updated', sessionId: entry.sessionId } as never).catch(() => undefined)
}

async function busForward(event: unknown): Promise<void> {
  const bus = await import('./remote/bus')
  bus.forward(event as never)
}

/** A fire reuses the session's own model and folder — nothing to re-pick. */
async function fire(entry: ScheduleEntry): Promise<void> {
  entry.lastRunAt = Date.now()
  entry.nextRunAt = nextOccurrence(entry, Date.now())
  persist()
  announce(entry)
  try {
    // A session can be closed or deleted between scheduling and firing. With
    // a recorded binding the schedule rebuilds an empty session with the same
    // mode and folder instead of dying; without one there is nothing to run.
    let liveSpecs = listSessionSpecs()
    if (!liveSpecs.some((spec) => spec.sessionId === entry.sessionId)) {
      const spec = entry.binding !== undefined ? rememberedSpec(entry.sessionId) : undefined
      if (spec === undefined) throw new Error('No such session')
      const rebuilt = recreateSession(spec)
      entry.sessionId = rebuilt.sessionId
      liveSpecs = listSessionSpecs()
      persist()
    }
    const status = getStatus(entry.sessionId)
    if (!status.providerReady) throw new Error(status.blockedReason ?? 'Agent is not ready')
    await submitPrompt(
      { sessionId: entry.sessionId, runId: randomUUID(), prompt: entry.prompt, attachmentIds: [] },
      approvals
    )
    entry.lastResult = 'started'
    delete entry.lastError
  } catch (error) {
    entry.lastResult = 'failed'
    entry.lastError = (error as Error).message.slice(0, 200)
  }
  persist()
  announce(entry)
}

function tick(): void {
  if (running) return
  running = true
  const now = Date.now()
  void (async () => {
    try {
      for (const entry of [...entries.values()]) {
        if (!entry.enabled || entry.nextRunAt === null) continue
        // A missed call still runs once — two minutes late beats never.
        if (entry.nextRunAt <= now && now - entry.nextRunAt < 120_000) await fire(entry)
        else if (entry.nextRunAt <= now - 120_000) {
          // The Mac slept through it: skip this slot, aim at the next one.
          entry.nextRunAt = nextOccurrence(entry, now)
          persist()
          announce(entry)
        }
      }
    } finally { running = false }
  })()
}

function scheduleState(): ScheduleEntry[] {
  return [...entries.values()].sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity))
}

export function listSchedules(): ScheduleEntry[] {
  return scheduleState()
}

export function startScheduler(): void {
  load()
  const now = Date.now()
  for (const entry of entries.values()) {
    if (entry.enabled && (entry.nextRunAt === null || entry.nextRunAt <= now)) {
      entry.nextRunAt = nextOccurrence(entry, now)
    }
  }
  persist()
  if (timer === null) timer = setInterval(tick, TICK)
}

export function stopScheduler(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}

export function addSchedule(input: {
  name: string; prompt: string; frequency: Frequency; hour: number; minute: number;
  weekday?: number; sessionId: string;
  newSession?: boolean; mode?: SessionMode; workspaceRoot?: string | null
}): ScheduleEntry {
  const prompt = input.prompt.trim()
  if (prompt === '') throw new Error('Give the schedule a prompt')
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23 ||
      !Number.isInteger(input.minute) || input.minute < 0 || input.minute > 59) {
    throw new Error('Pick a time of day')
  }
  if (input.frequency === 'weekly' && (input.weekday === undefined || input.weekday < 0 || input.weekday > 6)) {
    throw new Error('Pick a weekday for a weekly schedule')
  }
  const {
    sessionId,
    newSession,
    mode,
    workspaceRoot,
    ...rest
  } = input as ScheduleInput & { newSession?: boolean; mode?: SessionMode; workspaceRoot?: string | null }

  let boundId = sessionId
  let binding: ScheduleEntry['binding'] = undefined
  if (newSession === true) {
    const folder = mode === 'code' ? workspaceRoot ?? null : null
    if (mode === 'code' && folder === null) throw new Error('Pick a folder for a new anticode session')
    const spec = createSession({ sessionId: randomUUID(), mode: mode ?? 'chat', workspaceRoot: folder })
    boundId = spec.sessionId
  } else if (sessionId !== '') {
    const known = listSessionSpecs().find((spec) => spec.sessionId === sessionId)
    if (known === undefined) {
      // A session the schedule outlived: its binding must already carry the
      // mode and folder needed to rebuild it, or the schedule cannot run.
      binding = rememberedSpec(sessionId)
      if (binding === undefined) throw new Error('No such session')
    } else {
      binding = { mode: known.mode, workspaceRoot: known.workspaceRoot }
    }
  } else {
    throw new Error('Pick a session, or create a new one')
  }

  const now = Date.now()
  const entry: ScheduleEntry = {
    id: randomUUID(),
    name: input.name.trim() || 'Scheduled run',
    prompt,
    frequency: rest.frequency,
    hour: rest.hour,
    minute: rest.minute,
    ...(rest.weekday !== undefined ? { weekday: rest.weekday } : {}),
    sessionId: boundId,
    ...(binding !== undefined ? { binding } : {}),
    enabled: true,
    nextRunAt: nextOccurrence({ ...input, weekday: rest.weekday } as ScheduleEntry, now),
    lastRunAt: null
  }
  entries.set(entry.id, entry)
  persist()
  announce(entry)
  return entry
}

export function updateSchedule(id: string, patch: Partial<ScheduleEntry>): ScheduleEntry {
  const entry = entries.get(id)
  if (entry === undefined) throw new Error('No such schedule')
  const merged: ScheduleEntry = { ...entry, ...patch, id: entry.id }
  if (typeof patch.prompt === 'string' && patch.prompt.trim() === '') throw new Error('Give the schedule a prompt')
  merged.nextRunAt = merged.enabled ? nextOccurrence(merged, Date.now()) : null
  entries.set(id, merged)
  persist()
  announce(merged)
  return merged
}

export function removeSchedule(id: string): void {
  entries.delete(id)
  persist()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IpcChannel.SCHEDULE_STATE, scheduleState())
  }
}

/** The desktop and the phone both offer: turn a chat into a schedule. */
export function scheduleFromSession(sessionId: string, name: string, prompt: string, frequency: Frequency, hour: number, minute: number, weekday?: number): ScheduleEntry {
  return addSchedule({ sessionId, name, prompt, frequency, hour, minute, ...(weekday !== undefined ? { weekday } : {}) })
}
