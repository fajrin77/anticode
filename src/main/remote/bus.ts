import type { AgentEvent } from '@shared/ipc'

type Listener = (event: AgentEvent) => void

/** runId → sessionId, so forwarded events land on the right stream. */
const runSessions = new Map<string, string>()
const listeners = new Map<string, Set<Listener>>()

export function registerRun(runId: string, sessionId: string): void {
  runSessions.set(runId, sessionId)
}

export function forgetRun(runId: string): void {
  runSessions.delete(runId)
}

/** Fans a desktop or remote event out to every subscriber of its session. */
export function forward(event: AgentEvent): void {
  const sessionId = runSessions.get(event.runId)
  if (sessionId === undefined) return
  if (event.type === 'end' || event.type === 'error') runSessions.delete(event.runId)
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
