import { BrowserWindow } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { AgentEvent } from '@shared/ipc'
import { recordRunSummary } from '../runtime'

type Listener = (event: AgentEvent) => void

/** runId → sessionId, so forwarded events land on the right stream. */
const runSessions = new Map<string, string>()
const listeners = new Map<string, Set<Listener>>()

/**
 * What each live run has spent so far. Every event already passes through
 * here, whoever started the run, so this is the one place that sees a whole
 * run from prompt to end — desktop and phone alike.
 */
const tallies = new Map<
  string,
  { startedAt: number; model: string; inputTokens: number; outputTokens: number; turns: number }
>()

function tally(runId: string): {
  startedAt: number
  model: string
  inputTokens: number
  outputTokens: number
  turns: number
} {
  const existing = tallies.get(runId)
  if (existing !== undefined) return existing
  const fresh = { startedAt: Date.now(), model: '', inputTokens: 0, outputTokens: 0, turns: 0 }
  tallies.set(runId, fresh)
  return fresh
}

/**
 * A run that never got a response leaves no assistant turn behind, so it must
 * leave no summary either — that one-to-one is what lets a viewer line the
 * summaries up with the turns without any bookkeeping of its own.
 */
function closeTally(runId: string, sessionId: string): void {
  const entry = tallies.get(runId)
  tallies.delete(runId)
  if (entry === undefined || entry.turns === 0) return
  recordRunSummary(sessionId, {
    model: entry.model,
    durationMs: Date.now() - entry.startedAt,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens
  })
}

export function registerRun(runId: string, sessionId: string): void {
  runSessions.set(runId, sessionId)
}

export function forgetRun(runId: string): void {
  runSessions.delete(runId)
}

/**
 * Fans a desktop or remote event out to every desktop window (so a run started
 * on the phone streams here too) and to every SSE subscriber of its session.
 */
export function forward(event: AgentEvent): void {
  const sessionId = runSessions.get(event.runId)
  if (sessionId === undefined) return

  if (event.type === 'prompt') tally(event.runId).startedAt = Date.now()
  else if (event.type === 'usage') {
    const entry = tally(event.runId)
    entry.model = event.model
    entry.inputTokens += event.inputTokens
    entry.outputTokens += event.outputTokens
    entry.turns += 1
  }

  if (event.type === 'end' || event.type === 'error') {
    runSessions.delete(event.runId)
    closeTally(event.runId, sessionId)
  }

  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed()) window.webContents.send(IpcChannel.AGENT_EVENT, { ...event, sessionId })
    } catch { /* A closing window must not interrupt other viewers. */ }
  }

  const set = listeners.get(sessionId)
  if (set === undefined) return
  for (const listener of set) {
    try {
      listener(event)
    } catch {
      // A dead subscriber must not break the others.
    }
  }
}

export function subscribe(sessionId: string, listener: Listener): () => void {
  const set = listeners.get(sessionId) ?? new Set()
  set.add(listener)
  listeners.set(sessionId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(sessionId)
  }
}
