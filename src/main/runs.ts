/** Shared ownership for desktop and phone runs. Cancellation keeps the reservation
 * until cleanup finishes, preventing a resume from racing pending tool writes. */
const runs = new Map<string, { sessionId: string; controller: AbortController; startedAt: number }>()

/**
 * Sessions whose run was paused. Kept here rather than in either viewer, so a
 * pause pressed on the phone is resumed from the desktop and the other way
 * round — each viewer used to keep its own and never heard of the other's.
 */
const paused = new Set<string>()
let pauseSink: ((sessionId: string, paused: boolean) => void) | null = null

/** Called once by ipc registration; tells every viewer when a pause starts or ends. */
export function setPauseSink(sink: (sessionId: string, paused: boolean) => void): void {
  pauseSink = sink
}

function setPaused(sessionId: string, value: boolean): void {
  if (paused.has(sessionId) === value) return
  if (value) paused.add(sessionId)
  else paused.delete(sessionId)
  pauseSink?.(sessionId, value)
}

export function beginRun(runId: string, sessionId: string): AbortController {
  if (runs.has(runId) || runForSession(sessionId) !== null) {
    throw new Error('A run is already active in this session. Wait for it to finish stopping.')
  }
  const controller = new AbortController()
  runs.set(runId, { sessionId, controller, startedAt: Date.now() })
  // A new run ends a pause, whether it is the resume or a fresh prompt.
  setPaused(sessionId, false)
  return controller
}
export function finishRun(runId: string): void { runs.delete(runId) }
export function cancelRun(runId: string): void { runs.get(runId)?.controller.abort() }
export function runForSession(sessionId: string): string | null {
  for (const [id, run] of runs) if (run.sessionId === sessionId) return id
  return null
}
export function cancelSessionRuns(sessionId: string): void {
  for (const run of runs.values()) if (run.sessionId === sessionId) run.controller.abort()
}
export function hasRuns(): boolean { return runs.size > 0 }
export function cancelAllRuns(): void { for (const run of runs.values()) run.controller.abort() }

export function listActiveRuns(): { runId: string; sessionId: string; startedAt: number }[] {
  return [...runs].map(([runId, run]) => ({ runId, sessionId: run.sessionId, startedAt: run.startedAt }))
}

/**
 * Stops the session's run and remembers it was a pause, so either viewer can
 * resume it. False when nothing is running: a run that already finished has
 * nothing to pause, and must not leave a Resume button behind on any screen.
 * Viewers are told before the run is stopped, so its end reads as a pause.
 */
export function pauseSession(sessionId: string): boolean {
  const runId = runForSession(sessionId)
  if (runId === null) return false
  setPaused(sessionId, true)
  cancelRun(runId)
  return true
}

/** Ends a pause without a run: the run finished anyway, or its turn was reverted. */
export function clearPause(sessionId: string): void {
  setPaused(sessionId, false)
}

export function isPaused(sessionId: string): boolean {
  return paused.has(sessionId)
}

export function listPausedSessions(): string[] {
  return [...paused]
}
