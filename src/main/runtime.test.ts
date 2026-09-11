import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ApprovalGate } from './approval/types'
import type { ProviderFallback } from './agent/loop'

const userData = mkdtempSync(path.join(tmpdir(), 'anticode-runtime-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))
vi.mock('./settings', () => ({ loadPersistedSettings: () => ({}), savePersistedSettings: () => undefined }))
vi.mock('./web', () => ({ clearWeb: () => undefined, restoreWeb: () => undefined, webRecord: () => undefined }))
vi.mock('./providers/models', () => ({ fetchModels: async () => [] }))
vi.mock('./providers', () => ({
  listProviders: () => [
    { id: 'one', label: 'One', defaultModel: 'm1', credentialAvailable: true, configured: true, credentialHint: '' },
    { id: 'two', label: 'Two', defaultModel: 'm2', credentialAvailable: true, configured: true, credentialHint: '' },
    { id: 'three', label: 'Three', defaultModel: 'm3', credentialAvailable: true, configured: true, credentialHint: '' }
  ],
  createProvider: (id: string, model: string) => ({
    name: id,
    model,
    async *chat() {
      yield { type: 'response', response: { content: [], stopReason: 'end_turn', usage: { inputTokens: 40, outputTokens: 2 } } }
    }
  })
}))
vi.mock('./agent/loop', () => ({
  titleOf: () => '',
  AgentSession: class {
    messageCount = 0
    fallback: ProviderFallback | null = null
    constructor(public provider: { name: string; model: string }) {}
    useProvider(provider: { name: string; model: string }, fallback: ProviderFallback | null): void {
      this.provider = provider
      this.fallback = fallback
    }
    snapshot(): { messages: never[] } { return { messages: [] } }
    dispose(): void {}
  }
}))

import {
  applyRotation,
  applyRotationEnabled,
  createSession,
  deleteSession,
  getSession,
  getStatus,
  providerInUse,
  selectProvider
} from './runtime'
import { recordRotationUsage, resetRotationForTests } from './rotation'
import { beginRun, finishRun } from './runs'
import { ROTATE_PROVIDER } from '@shared/ipc'

const gate = {} as ApprovalGate
type FakeAgent = { provider: { name: string; model: string }; fallback: ProviderFallback | null }
const agentOf = (sessionId: string): FakeAgent => getSession(sessionId, gate) as unknown as FakeAgent
const modelOf = (sessionId: string): string => agentOf(sessionId).provider.model

beforeEach(() => {
  resetRotationForTests()
  applyRotation([])
  applyRotationEnabled(false)
  selectProvider({ provider: 'one', model: 'm1' })
  for (const id of ['a', 'b', 'c']) deleteSession(id)
})
afterEach(() => {
  finishRun('run-a')
  finishRun('run-b')
})

it('changes one session’s model without touching another, even while that one runs', () => {
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  createSession({ sessionId: 'b', mode: 'chat', workspaceRoot: null })
  expect(modelOf('a')).toBe('m1')
  beginRun('run-a', 'a')

  // Picked in tab b while session a is still running.
  expect(() => selectProvider({ provider: 'two', model: 'm2' }, 'b')).not.toThrow()
  expect(providerInUse('one')).toBe(true)
  expect(providerInUse('two')).toBe(false)

  // a follow-up to the running session reaches the agent that is running…
  expect(modelOf('a')).toBe('m1')
  // …b moves to its new model straight away…
  expect(modelOf('b')).toBe('m2')
  // …and a stays on its own model after its run, too.
  finishRun('run-a')
  expect(modelOf('a')).toBe('m1')
  expect(getStatus('a').model).toBe('m1')
  expect(getStatus('b').model).toBe('m2')
  expect(getStatus().sessions['a']?.model).toBe('m1')
})

it('makes the latest pick what new sessions start on', () => {
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  selectProvider({ provider: 'two', model: 'm2' }, 'a')
  expect(getStatus().model).toBe('m2')

  createSession({ sessionId: 'b', mode: 'chat', workspaceRoot: null })
  expect(modelOf('b')).toBe('m2')

  // A default set in Settings leaves every existing session where it was.
  selectProvider({ provider: 'three', model: 'm3' })
  expect(modelOf('a')).toBe('m2')
  expect(modelOf('b')).toBe('m2')
  createSession({ sessionId: 'c', mode: 'chat', workspaceRoot: null })
  expect(modelOf('c')).toBe('m3')
})

it('keeps a draft’s model when it is rebound to its folder on first send', () => {
  createSession({ sessionId: 'a', mode: 'code', workspaceRoot: null })
  selectProvider({ provider: 'two', model: 'm2' }, 'a')
  selectProvider({ provider: 'three', model: 'm3' })
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  expect(modelOf('a')).toBe('m2')
})

it('starts a provider picked without a model on the first model chosen for it', () => {
  applyRotation([{ provider: 'two', model: 'm2b' }, { provider: 'two', model: 'm2' }])
  selectProvider({ provider: 'two', model: '' })
  expect(getStatus().model).toBe('m2b')
})

it('uses the connected provider default while Rotate usage is off', () => {
  applyRotation([])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  expect(getStatus('a')).toMatchObject({ model: 'm1', providerReady: true })
})

it('does not move a fixed session when the inactive rotation pool changes', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'one', model: 'm1b' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  selectProvider({ provider: 'one', model: 'm1b' }, 'a')
  applyRotation([{ provider: 'one', model: 'm1' }])
  expect(modelOf('a')).toBe('m1b')
})

it('chooses an id typed by hand, so the composer offers it', () => {
  selectProvider({ provider: 'two', model: 'typed/model' })
  expect(getStatus().model).toBe('typed/model')
  expect(getStatus().rotation.some((entry) => entry.provider === 'two' && entry.model === 'typed/model')).toBe(true)
})

it('refuses Rotate while the pool is empty', () => {
  applyRotation([])
  expect(() => selectProvider({ provider: ROTATE_PROVIDER, model: '' })).toThrow(/Rotate usage/)
})

it('applies Rotate usage globally to existing and new sessions and locks model picks', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })

  applyRotationEnabled(true)
  expect(getStatus().provider).toBe(ROTATE_PROVIDER)
  expect(getStatus('a').provider).toBe(ROTATE_PROVIDER)
  expect(() => selectProvider({ provider: 'two', model: 'm2' }, 'a')).toThrow(/Turn off Rotate usage/)

  createSession({ sessionId: 'b', mode: 'chat', workspaceRoot: null })
  expect(getStatus('b').provider).toBe(ROTATE_PROVIDER)
})

it('falls every composer back to the first connected provider when Rotate usage is turned off', () => {
  applyRotation([{ provider: 'two', model: 'm2' }, { provider: 'one', model: 'm1' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)

  applyRotationEnabled(false)
  expect(getStatus()).toMatchObject({ provider: 'one', model: 'm1', providerReady: true })
  expect(getStatus('a')).toMatchObject({ provider: 'one', model: 'm1', providerReady: true })
})

it('keeps a rotating session on one model for two prompts, then moves to the least-used other', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }, { provider: 'three', model: 'm3' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)
  selectProvider({ provider: ROTATE_PROVIDER, model: '' }, 'a')
  expect(getStatus('a').providerReady).toBe(true)

  expect(modelOf('a')).toBe('m1')
  // Heavier use does not cut a model's two prompts short…
  recordRotationUsage({ provider: 'one', model: 'm1' }, { inputTokens: 500, outputTokens: 100 })
  expect(modelOf('a')).toBe('m1')
  // …and after them the least-used of the others takes over.
  recordRotationUsage({ provider: 'two', model: 'm2' }, { inputTokens: 900, outputTokens: 0 })
  expect(modelOf('a')).toBe('m3')
  expect(getStatus('a').lastUsed).toEqual({ provider: 'three', model: 'm3' })
  expect(modelOf('a')).toBe('m3')
  // m1 has used less than m2, and m3 has had its turn.
  expect(modelOf('a')).toBe('m1')

  const counts = getStatus().rotation.map((entry) => entry.inputTokens + entry.outputTokens)
  expect(counts).toEqual([600, 900, 0])
})

it('moves on early when the model it was on starts resting', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)
  selectProvider({ provider: ROTATE_PROVIDER, model: '' }, 'a')
  const agent = agentOf('a')
  expect(agent.provider.model).toBe('m1')
  // The first prompt failed over: m2 took it, and counts it as its first.
  expect(agent.fallback?.(Object.assign(new Error('limit'), { status: 429 }))?.model).toBe('m2')
  expect(modelOf('a')).toBe('m2')
  // Two on m2; m1 is still resting, so m2 carries on rather than stop.
  expect(modelOf('a')).toBe('m2')
})

it('stays on the only model in the pool', () => {
  applyRotation([{ provider: 'one', model: 'm1' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)
  selectProvider({ provider: ROTATE_PROVIDER, model: '' }, 'a')
  expect([modelOf('a'), modelOf('a'), modelOf('a')]).toEqual(['m1', 'm1', 'm1'])
})

it('counts tokens spent by the globally rotating session', async () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)
  const provider = agentOf('a').provider as unknown as { chat: (params: unknown) => AsyncIterable<unknown> }
  for await (const _event of provider.chat({})) { /* drain */ }
  expect(getStatus().rotation.map((entry) => [entry.inputTokens, entry.outputTokens])).toEqual([[40, 2], [0, 0]])
})

it('spreads prompts sent together over the pool before any tokens are counted', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  createSession({ sessionId: 'b', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)
  selectProvider({ provider: ROTATE_PROVIDER, model: '' }, 'a')
  selectProvider({ provider: ROTATE_PROVIDER, model: '' }, 'b')

  expect(modelOf('a')).toBe('m1')
  beginRun('run-a', 'a')
  expect(modelOf('b')).toBe('m2')
})

it('hands a failed turn to the next pool entry and rests the one that failed', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)
  selectProvider({ provider: ROTATE_PROVIDER, model: '' }, 'a')

  const agent = agentOf('a')
  expect(agent.provider.model).toBe('m1')
  const next = agent.fallback?.(Object.assign(new Error('rate limited'), { status: 429 }))
  expect(next?.model).toBe('m2')
  // Nothing left to try in this turn.
  expect(agent.fallback?.(new Error('down'))).toBeNull()

  const pool = getStatus().rotation
  expect(pool.every((entry) => entry.coolingUntil !== null)).toBe(true)
  expect(() => selectProvider({ provider: 'three', model: 'm3' }, 'a')).toThrow(/Turn off Rotate usage/)
})

it('offers no Rotate and counts nothing while Rotate usage is off', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  applyRotationEnabled(false)
  expect(getStatus().rotationEnabled).toBe(false)
  expect(() => selectProvider({ provider: ROTATE_PROVIDER, model: '' })).toThrow(/Rotate usage is off/)
  recordRotationUsage({ provider: 'one', model: 'm1' }, { inputTokens: 500, outputTokens: 100 })
  expect(getStatus().rotation.map((entry) => entry.inputTokens + entry.outputTokens)).toEqual([0, 0])
})

it('moves sessions off Rotate when Rotate usage is switched off', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  createSession({ sessionId: 'b', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)
  selectProvider({ provider: ROTATE_PROVIDER, model: '' }, 'a')
  selectProvider({ provider: ROTATE_PROVIDER, model: '' }, 'b')
  const used = modelOf('a')

  applyRotationEnabled(false)
  // The one that sent a prompt keeps the model it went to; the default and
  // the one that never sent anything land on a plain model.
  expect(getStatus('a')).toMatchObject({ provider: used === 'm1' ? 'one' : 'two', model: used, providerReady: true })
  expect(getStatus().provider).not.toBe(ROTATE_PROVIDER)
  expect(getStatus('b').provider).not.toBe(ROTATE_PROVIDER)
  expect(getStatus('b').providerReady).toBe(true)
})

it('keeps the global Rotate mode visible when its pool is emptied', () => {
  applyRotation([{ provider: 'one', model: 'm1' }])
  applyRotationEnabled(true)
  expect(getStatus().provider).toBe(ROTATE_PROVIDER)
  applyRotation([])
  expect(getStatus()).toMatchObject({ provider: ROTATE_PROVIDER, providerReady: false })
})

it('starts a model joining the pool level with the least-used one, not at zero', () => {
  applyRotation([{ provider: 'one', model: 'm1' }])
  applyRotationEnabled(true)
  recordRotationUsage({ provider: 'one', model: 'm1' }, { inputTokens: 300, outputTokens: 0 })
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  expect(getStatus().rotation.map((entry) => entry.inputTokens)).toEqual([300, 300])
})
