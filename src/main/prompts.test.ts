import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/ipc'
import type { ApprovalGate } from './approval/types'
import type { AgentSession } from './agent/loop'
type RunParams = Parameters<AgentSession['run']>[0]
const mocks = vi.hoisted(() => ({
  run: vi.fn(), steer: vi.fn(() => true), blocks: vi.fn(async () => []),
  forward: vi.fn(), persist: vi.fn(), register: vi.fn(), ready: true, pause: vi.fn()
}))
vi.mock('./runtime', () => ({
  getStatus: () => ({ providerReady: mocks.ready }),
  getSession: () => ({ run: mocks.run, steer: mocks.steer }), persistSessions: mocks.persist,
  announceTitle: () => undefined, selectProvider: () => undefined, takeBackPrompt: () => null
}))
vi.mock('./attachments/registry', () => ({
  attachmentsFor: () => [], blocksOf: mocks.blocks, refsOf: () => [], releaseAttachments: vi.fn(), stagedRefs: () => []
}))
vi.mock('./remote/bus', () => ({
  forward: mocks.forward, registerRun: mocks.register, announceStatus: () => undefined, announceHistory: () => undefined
}))
import { forgetQueue, queuePrompt, submitPrompt, unqueuePrompt } from './prompts'
import { listQueue } from './queue'
import { clearPause, finishRun, pauseSession, runForSession } from './runs'
const gate = {} as ApprovalGate
const request = (runId: string) => ({ runId, sessionId: 'session', prompt: runId, attachmentIds: [] })
afterEach(() => {
  finishRun('desktop'); finishRun('phone'); forgetQueue('session'); clearPause('session')
  vi.clearAllMocks(); mocks.ready = true
})
it('admits simultaneous desktop and phone sends into one run after attachments finish', async () => {
  let prepare!: () => void
  mocks.blocks.mockImplementationOnce(() => new Promise((resolve) => { prepare = () => resolve([]) }))
  let complete!: () => void
  mocks.run.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve }))
  const desktop = submitPrompt(request('desktop'), gate)
  const phone = submitPrompt(request('phone'), gate)
  await vi.waitFor(() => expect(prepare).toBeDefined())
  expect(mocks.run).not.toHaveBeenCalled()
  prepare()
  expect(await desktop).toEqual({ runId: 'desktop', steered: false })
  expect(await phone).toEqual({ runId: 'desktop', steered: true })
  expect(mocks.run).toHaveBeenCalledTimes(1)
  expect(mocks.steer).toHaveBeenCalledWith('phone', [])
  complete()
  await vi.waitFor(() => expect(runForSession('session')).toBeNull())
})
it('steers a text-only prompt without waiting for attachment preparation', async () => {
  let complete!: () => void
  mocks.run.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve }))
  await submitPrompt(request('desktop'), gate)
  mocks.blocks.mockClear()

  expect(await submitPrompt(request('phone'), gate)).toEqual({ runId: 'desktop', steered: true })
  expect(mocks.blocks).not.toHaveBeenCalled()
  expect(mocks.steer).toHaveBeenCalledWith('phone', [])
  expect(mocks.forward).toHaveBeenCalledWith({
    type: 'steer', runId: 'desktop', text: 'phone', attachments: []
  })

  complete()
  await vi.waitFor(() => expect(runForSession('session')).toBeNull())
})
it('lines a prompt up when the session was paused mid-run instead of erroring', async () => {
  // Both runs hold: the paused one and the queued one that starts after it.
  const held: Array<() => void> = []
  mocks.run.mockImplementation(() => new Promise<void>((resolve) => { held.push(resolve) }))
  const first = submitPrompt(request('desktop'), gate)
  await vi.waitFor(() => expect(runForSession('session')).toBe('desktop'))
  pauseSession('session')
  const followup = await submitPrompt(request('phone'), gate)
  expect(followup.steered).toBe(false)
  expect(mocks.steer).not.toHaveBeenCalledWith('phone', [])
  expect(listQueue('session').map((entry) => entry.text)).toContain('phone')
  expect(listQueue('session').length).toBeGreaterThan(0)
  // Ending the paused run hands the line to the queued prompt, which also
  // completes — the session must end free of both.
  held[0]?.()
  await vi.waitFor(() => expect(held.length).toBe(2))
  held[1]?.()
  await first
  await vi.waitFor(() => expect(runForSession('session')).toBeNull())
})
it('publishes completion only after agent cleanup and releasing run ownership', async () => {
  let cleaned = false
  mocks.run.mockImplementation(async (params: RunParams) => {
    params.emit({ type: 'end', runId: params.runId, reason: 'complete' })
    await Promise.resolve()
    cleaned = true
  })
  mocks.forward.mockImplementation((event: AgentEvent) => {
    if (event.type === 'end') {
      expect(cleaned).toBe(true)
      expect(runForSession('session')).toBeNull()
    }
  })
  await submitPrompt(request('desktop'), gate)
  await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalled())
  expect(mocks.forward).toHaveBeenCalledWith({ type: 'end', runId: 'desktop', reason: 'complete' })
})
it('a failed preparation does not lock the session or block its next prompt', async () => {
  mocks.blocks.mockRejectedValueOnce(new Error('Unreadable attachment'))
  mocks.run.mockResolvedValue(undefined)
  await expect(submitPrompt(request('desktop'), gate)).rejects.toThrow('Unreadable attachment')
  expect(runForSession('session')).toBeNull()
  expect(await submitPrompt(request('phone'), gate)).toEqual({ runId: 'phone', steered: false })
  await vi.waitFor(() => expect(runForSession('session')).toBeNull())
})
it('enforces the same prompt and attachment validation for both callers', async () => {
  await expect(submitPrompt({ ...request('desktop'), prompt: ' '.repeat(4) }, gate)).rejects.toThrow(/Enter a prompt/)
  await expect(submitPrompt({ ...request('phone'), prompt: 'x'.repeat(200_001) }, gate)).rejects.toThrow(/200,000/)
  expect(mocks.run).not.toHaveBeenCalled()
})

describe('the prompt queue', () => {
  /** Runs that stay open until the test ends them with the given reason. */
  function holdRuns(): { ids: string[]; end: (reason: 'complete' | 'cancelled') => void } {
    const held: { params: RunParams; resolve: () => void }[] = []
    mocks.run.mockImplementation((params: RunParams) => new Promise<void>((resolve) => { held.push({ params, resolve }) }))
    return {
      get ids() { return held.map((entry) => entry.params.prompt) },
      end: (reason) => {
        const current = held.at(-1)
        if (current === undefined) throw new Error('nothing running')
        current.params.emit({ type: 'end', runId: current.params.runId, reason })
        current.resolve()
      }
    }
  }

  it('starts at once when nothing is running', async () => {
    holdRuns()
    expect(await queuePrompt(request('desktop'), gate)).toEqual({ runId: 'desktop', queued: false })
    expect(listQueue('session')).toEqual([])
  })

  it('waits for the run to finish, then goes out as the next run', async () => {
    const runs = holdRuns()
    await submitPrompt(request('desktop'), gate)
    expect(await queuePrompt({ ...request('queued'), prompt: 'after that' }, gate)).toEqual({ runId: 'desktop', queued: true })
    expect(listQueue('session').map((item) => item.text)).toEqual(['after that'])
    expect(mocks.run).toHaveBeenCalledTimes(1)

    runs.end('complete')
    await vi.waitFor(() => expect(runs.ids).toEqual(['desktop', 'after that']))
    expect(listQueue('session')).toEqual([])
    runs.end('complete')
    await vi.waitFor(() => expect(runForSession('session')).toBeNull())
  })

  it('stays put while the run is paused, and carries on after it completes', async () => {
    const runs = holdRuns()
    await submitPrompt(request('desktop'), gate)
    await queuePrompt({ ...request('queued'), prompt: 'later' }, gate)
    runs.end('cancelled')
    await vi.waitFor(() => expect(runForSession('session')).toBeNull())
    expect(listQueue('session').map((item) => item.text)).toEqual(['later'])

    await submitPrompt(request('phone'), gate)
    runs.end('complete')
    await vi.waitFor(() => expect(runs.ids).toEqual(['desktop', 'phone', 'later']))
    runs.end('complete')
    await vi.waitFor(() => expect(runForSession('session')).toBeNull())
  })

  it('takes a prompt off the line on request', async () => {
    const runs = holdRuns()
    await submitPrompt(request('desktop'), gate)
    await queuePrompt({ ...request('queued'), prompt: 'never mind' }, gate)
    const [item] = listQueue('session')
    expect(unqueuePrompt('session', item?.id ?? '')).toMatchObject({ text: 'never mind' })
    runs.end('complete')
    await vi.waitFor(() => expect(runForSession('session')).toBeNull())
    expect(mocks.run).toHaveBeenCalledTimes(1)
  })
})
