import { afterEach, expect, it, vi } from 'vitest'
import type { SnapshotMessage } from '@shared/ipc'
const mocks = vi.hoisted(() => ({ messages: [] as SnapshotMessage[], record: vi.fn(), notify: vi.fn() }))
vi.mock('../notify', () => ({ notify: mocks.notify }))
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
afterEach(() => { finishRun('run'); forgetRun('run'); clearPause('session'); mocks.messages = []; mocks.notify.mockClear() })

it('notifies with a readable closing result instead of duration or tool narration', () => {
  registerRun('run', 'session')
  forward({ type: 'text_delta', runId: 'run', text: 'Saya akan memeriksa file.' })
  forward({ type: 'tool_start', runId: 'run', toolUseId: 'tool', name: 'read_file', input: {} })
  forward({ type: 'text_delta', runId: 'run', text: '**Filter stok** sudah diperbaiki.\n' })
  forward({ type: 'text_delta', runId: 'run', text: 'Commit: `abc123`.' })
  forward({ type: 'end', runId: 'run', reason: 'complete' })
  expect(mocks.notify).toHaveBeenCalledWith('complete', {
    title: 'session', body: 'Filter stok sudah diperbaiki. Commit: abc123.', sessionId: 'session'
  })
})

it('bounds the completion preview to notification space', () => {
  registerRun('run', 'session')
  forward({ type: 'text_delta', runId: 'run', text: 'a'.repeat(300) })
  forward({ type: 'end', runId: 'run', reason: 'complete' })
  expect(mocks.notify.mock.calls[0]?.[1].body).toBe('a'.repeat(239) + '…')
})

it('does not expose tool narration when there is no closing answer', () => {
  registerRun('run', 'session')
  forward({ type: 'text_delta', runId: 'run', text: 'Memeriksa rahasia.' })
  forward({ type: 'tool_start', runId: 'run', toolUseId: 'tool', name: 'read_file', input: {} })
  forward({ type: 'end', runId: 'run', reason: 'complete' })
  expect(mocks.notify.mock.calls[0]?.[1].body).toBe('Selesai. Buka sesi untuk melihat hasil.')
})
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

it.each(['error', 'cancelled', 'complete'] as const)('persists an honest %s outcome for a partial or finished report', (outcome) => {
  mocks.record.mockClear()
  beginRun('run', 'session'); registerRun('run', 'session')
  forward({ type: 'prompt', runId: 'run', text: 'work' })
  forward({ type: 'usage', runId: 'run', provider: 'fixture', model: 'fixture-model', inputTokens: 10, outputTokens: 5 })
  finishRun('run')
  if (outcome === 'error') forward({ type: 'error', runId: 'run', message: 'connection lost', retryable: true })
  else forward({ type: 'end', runId: 'run', reason: outcome })
  expect(mocks.record).toHaveBeenCalledWith('session', expect.objectContaining({ outcome: outcome === 'cancelled' ? 'interrupted' : outcome }))
})
