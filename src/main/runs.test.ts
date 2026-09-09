import { afterEach, expect, it } from 'vitest'
import { beginRun, cancelRun, finishRun, runForSession } from './runs'
afterEach(() => { for (const id of ['desktop', 'phone', 'other']) finishRun(id) })
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
