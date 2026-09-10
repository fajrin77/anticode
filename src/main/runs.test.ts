import { afterEach, expect, it } from 'vitest'
import {
  beginRun,
  cancelRun,
  clearPause,
  finishRun,
  isPaused,
  pauseSession,
  runForSession,
  setPauseSink
} from './runs'
afterEach(() => {
  for (const id of ['desktop', 'phone', 'other']) finishRun(id)
  for (const id of ['session', 'a', 'b']) clearPause(id)
  setPauseSink(() => undefined)
})
it('shares session ownership across callers and keeps the lock until cancellation finishes', () => {
  const controller = beginRun('desktop', 'session')
  expect(() => beginRun('phone', 'session')).toThrow(/already active/)
  cancelRun('desktop')
  expect(controller.signal.aborted).toBe(true)
  expect(() => beginRun('phone', 'session')).toThrow()
  finishRun('desktop')
  expect(beginRun('phone', 'session').signal.aborted).toBe(false)
})
it('allows different sessions without overwriting their run', () => {
  beginRun('desktop', 'a'); beginRun('phone', 'b')
  expect(runForSession('a')).toBe('desktop')
  expect(runForSession('b')).toBe('phone')
})
it('pauses a run for every viewer, and the next run anywhere resumes it', () => {
  const told: [string, boolean][] = []
  setPauseSink((sessionId, paused) => told.push([sessionId, paused]))
  const controller = beginRun('phone', 'session')
  expect(pauseSession('session')).toBe(true)
  expect(controller.signal.aborted).toBe(true)
  expect(isPaused('session')).toBe(true)
  finishRun('phone')
  // Resumed from the other viewer: a new run in the session ends the pause.
  beginRun('desktop', 'session')
  expect(isPaused('session')).toBe(false)
  expect(told).toEqual([['session', true], ['session', false]])
})
it('does not pause a session whose run already finished', () => {
  const told: [string, boolean][] = []
  setPauseSink((sessionId, paused) => told.push([sessionId, paused]))
  expect(pauseSession('session')).toBe(false)
  expect(isPaused('session')).toBe(false)
  expect(told).toEqual([])
})
