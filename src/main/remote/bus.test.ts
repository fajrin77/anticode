import { afterEach, expect, it, vi } from 'vitest'
import type { SnapshotMessage } from '@shared/ipc'
const mocks = vi.hoisted(() => ({ messages: [] as SnapshotMessage[], record: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => ({}) },
  Notification: { isSupported: () => false }
}))
vi.mock('../runtime', () => ({
  getStatus: () => ({}), recordRunSummary: mocks.record,
  loadSessionMessages: () => mocks.messages, loadSessionSummaries: () => []
}))
import { forward, registerRun, sessionSnapshot, subscribe, forgetRun } from './bus'
import { beginRun, finishRun } from '../runs'
afterEach(() => { finishRun('run'); forgetRun('run'); mocks.messages = [] })
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
