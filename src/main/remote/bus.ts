import { BrowserWindow, Notification } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { AgentEvent, QueuedPrompt, SessionPause, SessionQueue, SessionSnapshot, SessionTitle, RoutedAgentEvent, RunSummary } from '@shared/ipc'
import { listQueue } from '../queue'
import { getStatus, recordRunSummary, loadSessionMessages, loadSessionSummaries } from '../runtime'
import { clearPause, isPaused, runForSession } from '../runs'

/**
 * What a session's phone stream carries: its runs, whether it is paused, word
 * that its history changed underneath (a turn was reverted), and its name.
 */
export type StreamEvent = (
  | AgentEvent
  | { type: 'pause'; paused: boolean }
  | { type: 'history' }
  | { type: 'title'; title: string }
  | { type: 'queue'; items: QueuedPrompt[] }
) & { revision?: number }
type Listener = (event: StreamEvent) => void

/** runId → sessionId, so forwarded events land on the right stream. */
const runSessions = new Map<string, string>()
const listeners = new Map<string, Set<Listener>>()
let revision = 0
const journals = new Map<string, Pick<SessionSnapshot, 'messages' | 'summaries' | 'events'>>()

/** A single synchronous read boundary for both viewers. Live runs replay from
 * their starting transcript, so snapshots neither lose nor duplicate deltas. */
export function sessionSnapshot(sessionId: string): SessionSnapshot | null {
  const messages = loadSessionMessages(sessionId)
  if (messages === null) return null
  const runId = runForSession(sessionId)
  const journal = runId === null ? undefined : journals.get(runId)
  return structuredClone({
    messages: journal?.messages ?? messages,
    summaries: journal?.summaries ?? loadSessionSummaries(sessionId),
    events: journal?.events ?? [], runId, paused: isPaused(sessionId), revision,
    queue: listQueue(sessionId)
  })
}

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
function closeTally(runId: string, sessionId: string): RunSummary | undefined {
  const entry = tallies.get(runId)
  tallies.delete(runId)
  if (entry === undefined || entry.turns === 0) return
  const summary = {
    model: entry.model,
    durationMs: Date.now() - entry.startedAt,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens
  }
  recordRunSummary(sessionId, summary)
  return summary
}

export function registerRun(runId: string, sessionId: string): void {
  runSessions.set(runId, sessionId)
  journals.set(runId, { messages: loadSessionMessages(sessionId) ?? [], summaries: [...loadSessionSummaries(sessionId)], events: [] })
}

export function forgetRun(runId: string): void {
  runSessions.delete(runId)
  journals.delete(runId)
  tallies.delete(runId)
}

/**
 * Fans a desktop or remote event out to every desktop window (so a run started
 * on the phone streams here too) and to every SSE subscriber of its session.
 */
export function forward(event: AgentEvent): void {
  const sessionId = runSessions.get(event.runId)
  if (sessionId === undefined) return
  const routed: RoutedAgentEvent = { ...event, sessionId }

  if (event.type === 'prompt') tally(event.runId).startedAt = Date.now()
  else if (event.type === 'usage') {
    const entry = tally(event.runId)
    entry.inputTokens += event.inputTokens
    entry.outputTokens += event.outputTokens
    // A sub-agent's request is part of the cost, not an assistant turn of
    // this session: it must not shift the one-summary-per-turn alignment.
    if (event.subagent !== true) {
      entry.model = event.model
      entry.turns += 1
    }
  }

  if (event.type === 'end' || event.type === 'error') {
    runSessions.delete(event.runId)
    journals.delete(event.runId)
    const summary = closeTally(event.runId, sessionId)
    if (summary !== undefined && (routed.type === 'end' || routed.type === 'error')) routed.summary = summary
    // Paused just as the run was finishing on its own: it finished, so there
    // is nothing left to resume on either screen.
    if (event.type === 'error' || event.reason !== 'cancelled') clearPause(sessionId)
    const focused = (BrowserWindow as typeof BrowserWindow & { getFocusedWindow?: () => unknown }).getFocusedWindow
    const supported = (Notification as typeof Notification | undefined)?.isSupported
    if (focused?.() === null && supported?.()) {
      const body = event.type === 'error'
        ? 'A run stopped with an error.'
        : event.reason === 'complete'
          ? 'Your run finished.'
          : `Your run stopped: ${event.reason}.`
      new Notification({ title: 'anticode', body }).show()
    }
  }

  // Clearing a pause can itself emit an event; number this event only after
  // that notification, in exactly the order viewers receive them.
  routed.revision = ++revision
  const events = journals.get(event.runId)?.events
  const previous = events?.at(-1)
  if (events !== undefined && previous?.type === 'text_delta' && routed.type === 'text_delta') {
    events[events.length - 1] = { ...routed, text: previous.text + routed.text }
  } else events?.push(routed)

  toWindows(IpcChannel.AGENT_EVENT, routed)
  toStreams(sessionId, routed)
}

/** A pause starting or ending, wherever it was pressed, reaches every viewer. */
export function announcePause(sessionId: string, paused: boolean): void {
  toWindows(IpcChannel.SESSION_PAUSED, { sessionId, paused } satisfies SessionPause)
  toStreams(sessionId, { type: 'pause', paused, revision: ++revision })
}

/**
 * A turn was taken back out of the session's history; whoever did not do it
 * redraws from the main process, or it keeps showing the exchange that is
 * gone. The screen that reverted has already redrawn itself, and a second
 * redraw there would only lose its pause and resume markers.
 */
export function announceHistory(sessionId: string, from: 'desktop' | 'phone'): void {
  if (from === 'phone') toWindows(IpcChannel.SESSION_HISTORY, sessionId)
  toStreams(sessionId, { type: 'history', revision: ++revision })
}

/** A queued prompt added, sent, or taken out, wherever: every viewer redraws the list. */
export function announceQueue(sessionId: string, items: QueuedPrompt[]): void {
  toWindows(IpcChannel.QUEUE_UPDATED, { sessionId, items } satisfies SessionQueue)
  toStreams(sessionId, { type: 'queue', items })
}

/** A session got its name; the desktop tab and the phone header both follow. */
export function announceSessionTitle(sessionId: string, title: string): void {
  toWindows(IpcChannel.SESSION_TITLE, { sessionId, title } satisfies SessionTitle)
  toStreams(sessionId, { type: 'title', title })
}

/** The model was switched from the phone; the desktop chip follows at once, not on its next poll. */
export function announceStatus(): void {
  toWindows(IpcChannel.STATUS_UPDATED, getStatus())
}

function toWindows(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    } catch { /* A closing window must not interrupt other viewers. */ }
  }
}

function toStreams(sessionId: string, event: StreamEvent): void {
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
