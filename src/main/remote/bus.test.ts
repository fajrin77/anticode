import { afterEach, expect, it, vi } from 'vitest'
import type { SnapshotMessage } from '@shared/ipc'
const mocks = vi.hoisted(() => ({ messages: [] as SnapshotMessage[], record: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => ({}) },
  Notification: { isSupported: () => false }
}))
vi.mock('../runtime', () => ({
  getStatus: () => ({}), recordRunSummary: mocks.record,
  loadSessionMessages: () => mocks.messages, loadSessionSummaries: () => [], sessionTitle: () => 'session'
}))
import { forward, registerRun, sessionSnapshot, subscribe, forgetRun } from './bus'
import { beginRun, clearPause, finishRun } from '../runs'
afterEach(() => { finishRun('run'); forgetRun('run'); clearPause('session'); mocks.messages = [] })
it('snapshots replay all live events from a stable baseline without duplicating committed text', () => {
  beginRun('run', 'session'); registerRun('run', 'session')
  forward({ type: 'prompt', runId: 'run', text: 'hello' })
  forward({ type: 'text_delta', runId: 'run', text: 'partial' })
  mocks.messages = [{ role: 'assistant', blocks: [{ type: 'text', text: 'partial' }] }]
  const snapshot = sessionSnapshot('session')!
  expect(snapshot.messages).toEqual([])
  expect(snapshot.events.map((event) => event.type)).toEqual(['prompt', 'text_delta'])
  expect(snapshot.runId).toBe('run')
  snapshot.events.length = 0
  expect(sessionSnapshot('session')!.events).toHaveLength(2)
  finishRun('run'); forward({ type: 'end', runId: 'run', reason: 'complete' })
  expect(sessionSnapshot('session')!.messages).toEqual(mocks.messages)
  expect(sessionSnapshot('session')!.events).toEqual([])
})
it('marks subsequent stream events newer than the snapshot boundary', () => {
  beginRun('run', 'session'); registerRun('run', 'session')
  const snapshot = sessionSnapshot('session')!
  const listener = vi.fn()
  const unsubscribe = subscribe('session', listener)
  forward({ type: 'text_delta', runId: 'run', text: 'arrived during fetch' })
  expect(listener.mock.calls[0]?.[0].revision).toBeGreaterThan(snapshot.revision)
  unsubscribe()
})

it('keeps stream revisions ordered when completion also clears a pause', async () => {
  const { pauseSession, setPauseSink } = await import('../runs')
  const { announcePause } = await import('./bus')
  setPauseSink(announcePause)
  beginRun('run', 'session'); registerRun('run', 'session')
  const received: { type: string; revision?: number }[] = []
  const unsubscribe = subscribe('session', (event) => received.push(event))
  try {
    pauseSession('session')
    finishRun('run')
    forward({ type: 'end', runId: 'run', reason: 'complete' })
    expect(received.map((event) => event.type)).toEqual(['pause', 'pause', 'end'])
    expect(received[2]!.revision).toBeGreaterThan(received[1]!.revision!)
  } finally { unsubscribe(); setPauseSink(() => undefined) }
})

it('keeps a retryable connection error paused after its run releases ownership', () => {
  beginRun('run', 'session'); registerRun('run', 'session')
  finishRun('run')
  forward({ type: 'error', runId: 'run', message: 'fetch failed', retryable: true })
  expect(sessionSnapshot('session')).toMatchObject({ runId: null, paused: true, pausedForRetry: true })
  // The next run — Continue or a new prompt — ends it like any pause.
  beginRun('run', 'session')
  expect(sessionSnapshot('session')).toMatchObject({ paused: false })
  expect(sessionSnapshot('session')).not.toHaveProperty('pausedForRetry')
})

it('gives a reply kept by a pause its own summary, so later replies keep theirs', () => {
  mocks.record.mockClear()
  beginRun('run', 'session'); registerRun('run', 'session')
  forward({ type: 'prompt', runId: 'run', text: 'long answer' })
  forward({ type: 'text_delta', runId: 'run', text: 'half of it' })
  finishRun('run')
  forward({ type: 'end', runId: 'run', reason: 'cancelled', keptReplyModel: 'model-a' })
  expect(mocks.record).toHaveBeenCalledWith('session', expect.objectContaining({ model: 'model-a', inputTokens: 0 }))
})

it('leaves no summary when a run stopped before writing anything', () => {
  mocks.record.mockClear()
  beginRun('run', 'session'); registerRun('run', 'session')
  forward({ type: 'prompt', runId: 'run', text: 'nothing yet' })
  finishRun('run')
  forward({ type: 'end', runId: 'run', reason: 'cancelled' })
  expect(mocks.record).not.toHaveBeenCalled()
})
