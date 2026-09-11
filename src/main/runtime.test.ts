import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApprovalGate } from './approval/types'

const userData = mkdtempSync(path.join(tmpdir(), 'anticode-runtime-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))
vi.mock('./settings', () => ({ loadPersistedSettings: () => ({}), savePersistedSettings: () => undefined }))
vi.mock('./web', () => ({ clearWeb: () => undefined, restoreWeb: () => undefined, webRecord: () => undefined }))
vi.mock('./providers/models', () => ({ fetchModels: async () => [] }))
vi.mock('./providers', () => ({
  listProviders: () => [
    { id: 'one', label: 'One', defaultModel: 'm1', credentialAvailable: true, configured: true, credentialHint: '' },
    { id: 'two', label: 'Two', defaultModel: 'm2', credentialAvailable: true, configured: true, credentialHint: '' }
  ],
  createProvider: (id: string, model: string) => ({ id, model })
}))
vi.mock('./agent/loop', () => ({
  titleOf: () => '',
  AgentSession: class {
    messageCount = 0
    constructor(readonly provider: { id: string; model: string }) {}
    snapshot(): { messages: never[] } { return { messages: [] } }
  }
}))

import { createSession, getSession, getStatus, providerInUse, selectProvider } from './runtime'
import { beginRun, finishRun } from './runs'

const gate = {} as ApprovalGate
const modelOf = (sessionId: string): string =>
  (getSession(sessionId, gate) as unknown as { provider: { model: string } }).provider.model

afterEach(() => finishRun('run-a'))

it('changes the model while another session works, without swapping the working agent', () => {
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  createSession({ sessionId: 'b', mode: 'chat', workspaceRoot: null })
  selectProvider({ provider: 'one', model: 'm1' })
  expect(modelOf('a')).toBe('m1')
  beginRun('run-a', 'a')

  // Picked in another tab while session a is still running.
  expect(() => selectProvider({ provider: 'two', model: 'm2' })).not.toThrow()
  expect(getStatus().model).toBe('m2')
  expect(providerInUse('one')).toBe(true)
  expect(providerInUse('two')).toBe(false)

  // a follow-up to the running session reaches the agent that is running…
  expect(modelOf('a')).toBe('m1')
  // …while the other session starts on the new model straight away,
  expect(modelOf('b')).toBe('m2')
  // and the running one takes it from its next prompt.
  finishRun('run-a')
  expect(modelOf('a')).toBe('m2')
})

it('starts a provider picked without a model on the first model listed for it', () => {
  selectProvider({ provider: 'two', model: '' })
  expect(getStatus().model).toBe('m2')
})
