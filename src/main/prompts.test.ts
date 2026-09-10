import { afterEach, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/ipc'
import type { ApprovalGate } from './approval/types'
import type { AgentSession } from './agent/loop'
type RunParams = Parameters<AgentSession['run']>[0]
const mocks = vi.hoisted(() => ({
  run: vi.fn(), steer: vi.fn(() => true), blocks: vi.fn(async () => []),
  forward: vi.fn(), persist: vi.fn(), register: vi.fn(), ready: true
}))
vi.mock('./runtime', () => ({
  getStatus: () => ({ providerReady: mocks.ready }),
  getSession: () => ({ run: mocks.run, steer: mocks.steer }), persistSessions: mocks.persist,
  announceTitle: () => undefined
}))
vi.mock('./attachments/registry', () => ({
  attachmentsFor: () => [], blocksOf: mocks.blocks, refsOf: () => [], releaseAttachments: vi.fn()
}))
vi.mock('./remote/bus', () => ({ forward: mocks.forward, registerRun: mocks.register }))
import { submitPrompt } from './prompts'
import { finishRun, runForSession } from './runs'
const gate = {} as ApprovalGate
const request = (runId: string) => ({ runId, sessionId: 'session', prompt: runId, attachmentIds: [] })
afterEach(() => {
  finishRun('desktop'); finishRun('phone')
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
