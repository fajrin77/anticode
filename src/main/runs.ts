/** Shared ownership for desktop and phone runs. Cancellation keeps the reservation
 * until cleanup finishes, preventing a resume from racing pending tool writes. */
const runs = new Map<string, { sessionId: string; controller: AbortController; startedAt: number }>()

export function beginRun(runId: string, sessionId: string): AbortController {
  if (runs.has(runId) || runForSession(sessionId) !== null) {
    throw new Error('A run is already active in this session. Wait for it to finish stopping.')
  }
  const controller = new AbortController()
  runs.set(runId, { sessionId, controller, startedAt: Date.now() })
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
