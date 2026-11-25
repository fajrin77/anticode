import { afterEach, expect, it, vi } from 'vitest'
import { allowAll } from './approval/types'
import { clearQueue } from './queue'
import { runForSession } from './runs'
import { queuePrompt, submitPrompt } from './prompts'

const fixture = vi.hoisted(() => ({
  getSession: vi.fn(),
  steer: vi.fn(),
  forward: vi.fn()
}))
vi.mock('./runtime', () => ({
  announceTitle: vi.fn(), getSession: fixture.getSession, getStatus: () => ({ providerReady: true }),
  loadSessionMessages: () => [], persistSessions: vi.fn()
}))
vi.mock('./remote/bus', () => ({
  forward: fixture.forward, registerRun: vi.fn(), announceStatus: vi.fn()
}))
vi.mock('./attachments/registry', () => ({
  attachmentsFor: async () => [], blocksOf: async () => [], refsOf: () => [],
  releaseAttachments: vi.fn(), stagedRefs: () => []
}))
vi.mock('./storageCleanup', () => ({ scheduleCheckpointCleanup: vi.fn() }))

let finish: (() => void) | undefined
afterEach(async () => {
  clearQueue('session')
  finish?.()
  await vi.waitFor(() => expect(runForSession('session')).toBeNull())
  fixture.getSession.mockReset()
  fixture.steer.mockReset()
  fixture.forward.mockReset()
})

it('serializes two queued sends so the second never steers the first', async () => {
  fixture.getSession.mockReturnValue({
    providerName: 'fixture', model: 'model',
    run: () => new Promise<void>(resolve => { finish = resolve }),
    steer: fixture.steer
  })
  const first = { sessionId: 'session', prompt: 'one', runId: 'first', attachmentIds: [] }
  const second = { ...first, prompt: 'two', runId: 'second' }
  const [one, two] = await Promise.all([queuePrompt(first, allowAll), queuePrompt(second, allowAll)])
  expect(one).toEqual({ runId: 'first', queued: false })
  expect(two).toEqual({ runId: 'first', queued: true })
  expect(fixture.steer).not.toHaveBeenCalled()
  expect(fixture.forward).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt', text: 'one' }))
  expect(clearQueue('session')).toMatchObject([{ text: 'two' }])
})

it('honors the preferred queue mode for an ordinary send that races with a new run', async () => {
  fixture.getSession.mockReturnValue({
    providerName: 'fixture', model: 'model',
    run: () => new Promise<void>(resolve => { finish = resolve }),
    steer: fixture.steer
  })
  const first = { sessionId: 'session', prompt: 'one', runId: 'first', attachmentIds: [] }
  await submitPrompt(first, allowAll)
  const result = await submitPrompt({ ...first, runId: 'second', prompt: 'two', followUp: 'queue' }, allowAll)
  expect(result).toEqual({ runId: 'first', steered: false, queued: true })
  expect(fixture.steer).not.toHaveBeenCalled()
})
