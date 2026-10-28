import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ApprovalGate } from './approval/types'
import type { ProviderFallback } from './agent/loop'
import type { Message } from './providers/types'
import type { ProviderInfo } from '@shared/ipc'
const extra = vi.hoisted(() => ({ providers: [] as ProviderInfo[], retired: new Map<string, string>(), models: [] as string[] }))
vi.mock('./routeAvailability', () => ({
  unavailableRoute: (provider: string, model: string) => extra.retired.get(`${provider}\n${model}`) ?? null,
  markRetiredRoute: (provider: string, model: string) => extra.retired.set(`${provider}\n${model}`, 'Route retired')
}))
vi.mock('./auth/provider', async (original) => ({ ...await original<typeof import('./auth/provider')>(), authProvider: (id: string, model: string) => ({ name: id, model, async *chat() { yield { type: 'response', response: { content: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } } } }) }))

const userData = mkdtempSync(path.join(tmpdir(), 'anticode-runtime-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))
vi.mock('./settings', () => ({ loadPersistedSettings: () => ({}), savePersistedSettings: () => undefined }))
vi.mock('./web', () => ({ clearWeb: () => undefined, restoreWeb: () => undefined, webRecord: () => undefined }))
vi.mock('./providers/models', () => ({ fetchModels: async () => extra.models }))
vi.mock('./providers', () => ({
  listProviders: () => [
    { id: 'one', billing: 'subscription', models: ['m1', 'm1b'], label: 'One', defaultModel: 'm1', credentialAvailable: true, configured: true, credentialHint: '' },
    { id: 'two', billing: 'subscription', label: 'Two', defaultModel: 'm2', credentialAvailable: true, configured: true, credentialHint: '' },
    { id: 'three', label: 'Three', defaultModel: 'm3', credentialAvailable: true, configured: true, credentialHint: '' },
    { id: 'known', label: 'Known', defaultModel: 'listed', credentialAvailable: true, configured: true, credentialHint: '', models: ['listed'] },
    ...extra.providers
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
    fallback: ProviderFallback | null = null
    messages: unknown[]
    constructor(
      public provider: { name: string; model: string },
      _gate: unknown,
      _mode: unknown,
      _root: unknown,
      initialHistory: unknown[] = []
    ) { this.messages = structuredClone(initialHistory) }
    get messageCount(): number { return this.messages.length }
    useProvider(provider: { name: string; model: string }, fallback: ProviderFallback | null): void {
      this.provider = provider
      this.fallback = fallback
    }
    snapshot(): { messages: unknown[] } { return { messages: structuredClone(this.messages) } }
    dispose(): void {}
  }
}))

import {
  syncAuthAccountRoutes,
  applyRotation,
  applyRotationEnabled,
  applySubscriptionRouting,
  applyRotationGroup,
  applyRotationGroups,
  cloneSession,
  createSession,
  deleteSession,
  getSession,
  getStatus,
  loadSessionMessages,
  providerInUse,
  selectProvider
} from './runtime'
import { countedProvider, isOutOfUsage, recordRotationUsage, resetRotationForTests, resetRotationUsage } from './rotation'
import { beginRun, finishRun } from './runs'
import { modelLabel, ROTATE_PROVIDER } from '@shared/ipc'
import { RetiredRouteError } from './providers/routeError'
import { InputRequestLimitError } from './providers/requestLimits'

const gate = {} as ApprovalGate
type FakeAgent = {
  provider: { name: string; model: string }
  fallback: ProviderFallback | null
  messages: Message[]
}
const agentOf = (sessionId: string): FakeAgent => getSession(sessionId, gate) as unknown as FakeAgent
const modelOf = (sessionId: string): string => agentOf(sessionId).provider.model

it.each(['codex', 'claude', 'cline', 'opencode-go', 'codebuddy'] as const)('hands %s requests to another account on connection/quota failures with the same model', (authKind) => {
  const model = authKind === 'claude' ? 'claude-fixture' : 'same'
  extra.providers = [1, 2].map((number) => ({ id: `auth:${authKind}-${number}`, label: 'Fixture', authKind, kind: 'auth', models: [model], defaultModel: model, credentialAvailable: true, configured: true, credentialHint: '' }))
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  selectProvider({ provider: extra.providers[0]!.id, model }, 'a')
  const agent = agentOf('a')
  expect(agent.provider.name).toBe(extra.providers[0]!.id)
  expect(agent.fallback?.(new Error('fetch failed'))).toMatchObject({ name: extra.providers[1]!.id, model })
  expect(() => agent.fallback?.(Object.assign(new Error('usage limit reached'), { status: 429 }))).toThrow('usage limit')
  expect(agentOf('a').provider.name).toBe(extra.providers[0]!.id) // A network failure did not exhaust this account.
})

it('does not rotate on unsupported capability/product access and rejects stale batch choices', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)
  const agent = agentOf('a')
  for (const status of [400, 404]) expect(agent.fallback?.(Object.assign(new Error('unsupported'), { status }))).toBeNull()
  expect(getStatus().rotation.every((entry) => entry.coolingUntil === null)).toBe(true)
  applyRotationEnabled(false)
  expect(() => selectProvider({ provider: 'three', model: 'moonshotai/kimi-k3:batch' }, 'a')).toThrow(/Batch/)
})

it('remembers a failed single account when a second one is added later', () => {
  const first: ProviderInfo = { id: 'auth:codex-first', label: 'First', authKind: 'codex', models: ['same'], defaultModel: 'same', credentialAvailable: true, configured: true, credentialHint: '' }
  extra.providers = [first]
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  selectProvider({ provider: first.id, model: 'same' }, 'a')
  expect(() => agentOf('a').fallback?.(Object.assign(new Error('usage limit reached'), { status: 429 }))).toThrow('usage limit')
  extra.providers.push({ ...first, id: 'auth:codex-second' })
  expect(agentOf('a').provider.name).toBe('auth:codex-second')
})

beforeEach(() => {
  extra.providers = []
  extra.retired.clear()
  extra.models = []
  resetRotationForTests()
  applyRotation([])
  applyRotationEnabled(false)
  selectProvider({ provider: 'one', model: 'm1' })
  for (const id of ['a', 'b', 'c', 'fork', 'copy', 'laguna']) deleteSession(id)
})

it('skips only the explicitly retired route, stays inside the active group, and preserves pool membership', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }, { provider: 'three', model: 'm3' }])
  applyRotationGroups([{ name: 'Selected', entries: [{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }] }])
  applyRotationGroup(getStatus().rotationGroups[0]!.id)
  applyRotationEnabled(true)
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  const agent = agentOf('a')
  expect(agent.provider.model).toBe('m1')
  expect(agent.fallback?.(new RetiredRouteError('m1'))?.model).toBe('m2')
  expect(getStatus().rotation.find(entry => entry.model === 'm1')).toMatchObject({ ready: false, unavailableReason: 'Route retired', outOfUsage: null, coolingUntil: null })
  expect(getStatus().rotation).toHaveLength(3)
  expect(agent.fallback?.(new RetiredRouteError('m2'))).toBeNull()
  expect(getStatus('a').providerReady).toBe(false)
  expect(() => agentOf('a')).toThrow(/No model/)
})

it('rotates a request that cannot fit without cooling down the source or calling it exhausted', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  applyRotationEnabled(true)
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  const agent = agentOf('a')
  expect(agent.fallback?.(new InputRequestLimitError(13114, 4064, true))?.model).toBe('m2')
  expect(getStatus().rotation[0]).toMatchObject({ ready: true, outOfUsage: null, coolingUntil: null })
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

it('clones a durable branch through the selected prompt and keeps its model choice', () => {
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null, colour: 2 })
  selectProvider({ provider: 'two', model: 'm2' }, 'a')
  const source = agentOf('a')
  source.messages.push(
    { role: 'user', content: [{ type: 'text', text: 'topik pertama' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'jawaban pertama' }] },
    { role: 'user', content: [{ type: 'text', text: 'topik cabang' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'jawaban yang tidak ikut' }] }
  )

  const branch = cloneSession('a', 'fork', 2, 7)

  expect(branch).toMatchObject({ sessionId: 'fork', mode: 'chat', colour: 7 })
  expect(loadSessionMessages('fork')?.map((message) => message.blocks[0])).toEqual([
    { type: 'text', text: 'topik pertama' },
    { type: 'text', text: 'jawaban pertama' },
    { type: 'text', text: 'topik cabang' }
  ])
  expect(getStatus('fork')).toMatchObject({ provider: 'two', model: 'm2' })
})

it('gives a duplicated chat its own attachment files and references', () => {
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  const sourceRoot = path.join(userData, 'antichat', 'a')
  mkdirSync(sourceRoot, { recursive: true })
  const original = path.join(sourceRoot, 'notes.txt')
  writeFileSync(original, 'private copy')
  agentOf('a').messages.push({
    role: 'user',
    content: [{
      type: 'text',
      text: 'Attachment: notes.txt',
      attachment: {
        name: 'notes.txt', path: original, workspacePath: 'notes.txt',
        kind: 'text', size: 12, thumbnail: null
      }
    }]
  })

  cloneSession('a', 'copy', null)

  const attachment = loadSessionMessages('copy')?.[0]?.blocks[0]
  expect(attachment?.type).toBe('attachment')
  if (attachment?.type !== 'attachment') throw new Error('missing cloned attachment')
  expect(attachment.attachment.path).toBe(path.join(userData, 'antichat', 'copy', 'notes.txt'))
  expect(existsSync(attachment.attachment.path)).toBe(true)
  expect(readFileSync(attachment.attachment.path, 'utf8')).toBe('private copy')
})

it('rejects a mistyped model without making it the default', () => {
  expect(() => selectProvider({ provider: 'known', model: 'listed-typo' })).toThrow(/Unknown model/)
  expect(getStatus().model).toBe('m1')
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

it('applies Rotate usage globally to existing and new sessions', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })

  applyRotationEnabled(true)
  expect(getStatus().provider).toBe(ROTATE_PROVIDER)
  expect(getStatus('a').provider).toBe(ROTATE_PROVIDER)

  createSession({ sessionId: 'b', mode: 'chat', workspaceRoot: null })
  expect(getStatus('b').provider).toBe(ROTATE_PROVIDER)
})

it('falls every composer back to the explicitly selected default when Rotate usage is turned off', () => {
  applyRotation([{ provider: 'two', model: 'm2' }, { provider: 'one', model: 'm1' }])
  selectProvider({ provider: 'two', model: 'm2' })
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)

  // The default can also be changed while rotation remains globally active.
  selectProvider({ provider: 'three', model: 'm3' })
  expect(getStatus()).toMatchObject({ provider: ROTATE_PROVIDER, defaultProvider: 'three', defaultModel: 'm3' })

  applyRotationEnabled(false)
  expect(getStatus()).toMatchObject({ provider: 'three', model: 'm3', providerReady: true })
  expect(getStatus('a')).toMatchObject({ provider: 'three', model: 'm3', providerReady: true })
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
  // Nothing left to try in this turn: both rest, so the run waits out the
  // cooldown instead of stopping — it only halts when tokens are truly spent.
  const waiter = agent.fallback?.(Object.assign(new Error('down'), { status: 503 }))
  expect(waiter).not.toBeNull()
  expect(waiter?.name).toContain('rotate-wait')

  const pool = getStatus().rotation
  expect(pool.every((entry) => entry.coolingUntil !== null)).toBe(true)
})

it('waits out a pool-wide cooldown and resumes on a recovered entry instead of stopping', async () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)
  selectProvider({ provider: ROTATE_PROVIDER, model: '' }, 'a')

  const agent = agentOf('a')
  expect(agent.provider.model).toBe('m1')

  // Both entries are rate limited with a short server-provided retry time,
  // the way a 429 with Retry-After arrives from a free gateway.
  const soon = Date.now() + 300
  expect(agent.fallback?.(Object.assign(new Error('rate limited'), { status: 429, retryAt: soon }))?.model).toBe('m2')
  // Every entry now rests. Instead of null (run stops) or a thrown error, the
  // fallback hands back a waiter that outlives the cooldown.
  const waiter = agent.fallback?.(Object.assign(new Error('rate limited'), { status: 429, retryAt: soon })) as
    { name: string; chat: (params: unknown) => AsyncIterable<unknown> } | null
  expect(waiter).not.toBeNull()
  expect(waiter?.name).toContain('rotate-wait')

  // Draining the waiter waits out the cooldown, then hands the turn to a
  // recovered entry and streams its answer through the counting wrapper.
  const events: unknown[] = []
  for await (const event of waiter!.chat({ signal: new AbortController().signal })) events.push(event)
  expect(events.some((event) => (event as { type: string }).type === 'response')).toBe(true)
  expect(Date.now()).toBeGreaterThanOrEqual(soon)
  // The session sits on a healthy entry again, mid-run, not stopped.
  expect(['m1', 'm2']).toContain(modelOf('a'))
  expect(getStatus().rotation.every((entry) => entry.outOfUsage === null)).toBe(true)
})

it('stops only when every pool entry has truly run out of tokens', async () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)
  selectProvider({ provider: ROTATE_PROVIDER, model: '' }, 'a')
  // Grab the agent before the pool is spent: a fresh getSession with every
  // entry exhausted refuses up front, which is its own correct guard.
  const agent = agentOf('a')

  await drain(spentProvider({ provider: 'one', model: 'm1' }))
  await drain(spentProvider({ provider: 'two', model: 'm2' }))
  expect(getStatus().rotation.every((entry) => entry.outOfUsage !== null)).toBe(true)

  // A spent pool is not waited out: the failure stands so the user sees the
  // quota truth instead of a run that silently spins forever.
  expect(agent.fallback?.(quotaError())).toBeNull()
  // And a new prompt on a spent pool is refused up front with the quota truth.
  expect(() => agentOf('a')).toThrow(/No model in Rotate usage is ready/)
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

const quotaError = (): Error => Object.assign(new Error('You exceeded your current quota, please check your plan and billing details.'), { status: 429, code: 'insufficient_quota' })

/** A provider whose every call fails the way a spent account does. */
function spentProvider(entry: { provider: string; model: string }): { chat: (params: unknown) => AsyncIterable<unknown> } {
  return countedProvider(entry, {
    name: entry.provider,
    model: entry.model,
    // eslint-disable-next-line require-yield
    async *chat() { throw quotaError() }
  }) as unknown as { chat: (params: unknown) => AsyncIterable<unknown> }
}

it('keeps image generation available through the rotation usage wrapper', async () => {
  const inner = {
    name: 'one',
    model: 'm1',
    async *chat() { yield { type: 'response' as const, response: { content: [], stopReason: 'end_turn' as const, usage: { inputTokens: 0, outputTokens: 0 } } } },
    async generateImage() { return { data: 'aW1hZ2U=', mediaType: 'image/png' } }
  }
  const provider = countedProvider({ provider: 'one', model: 'm1' }, inner)
  await expect(provider.generateImage?.({
    prompt: 'test',
    model: 'gpt-image-1',
    size: '1024x1024',
    quality: 'auto',
    signal: new AbortController().signal
  })).resolves.toEqual({ data: 'aW1hZ2U=', mediaType: 'image/png' })
})

async function drain(provider: { chat: (params: unknown) => AsyncIterable<unknown> }): Promise<void> {
  try { for await (const _event of provider.chat({})) { /* drain */ } } catch { /* expected */ }
}

it('tells a spent quota from a passing rate limit', () => {
  expect(isOutOfUsage(quotaError())).toBe(true)
  expect(isOutOfUsage(Object.assign(new Error('Insufficient credits'), { status: 402 }))).toBe(true)
  expect(isOutOfUsage(new Error('Your credit balance is too low to access the Anthropic API.'))).toBe(true)
  expect(isOutOfUsage(Object.assign(new Error('Rate limit reached for requests'), { status: 429 }))).toBe(false)
  expect(isOutOfUsage(new Error('socket hang up'))).toBe(false)
})

it('marks a model out of usage, rotates past it, and clears it once it answers again', async () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)

  await drain(spentProvider({ provider: 'one', model: 'm1' }))
  const marked = getStatus().rotation.find((entry) => entry.model === 'm1')
  expect(marked?.outOfUsage?.reason).toMatch(/exceeded your current quota/)
  expect(getStatus().rotation.find((entry) => entry.model === 'm2')?.outOfUsage).toBeNull()

  // m1 has used nothing, yet the spent one goes last.
  expect([modelOf('a'), modelOf('a'), modelOf('a')]).toEqual(['m2', 'm2', 'm2'])

  // A reply from it means it was topped up.
  const answering = countedProvider({ provider: 'one', model: 'm1' }, {
    name: 'one', model: 'm1',
    async *chat() { yield { type: 'response', response: { content: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } } }
  }) as unknown as { chat: (params: unknown) => AsyncIterable<unknown> }
  await drain(answering)
  expect(getStatus().rotation.find((entry) => entry.model === 'm1')?.outOfUsage).toBeNull()
})

it('marks output-credit exhaustion and selects another enabled provider', async () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)
  const failing = countedProvider({ provider: 'one', model: 'm1' }, {
    name: 'one', model: 'm1',
    async *chat() {
      throw Object.assign(new Error('This request requires more credits, or fewer max_tokens. You requested up to 16000 tokens, but can only afford 228.'), { status: 402 })
    }
  }) as unknown as { chat: (params: unknown) => AsyncIterable<unknown> }
  await drain(failing)
  expect(getStatus().rotation.find(entry => entry.model === 'm1')?.outOfUsage?.reason).toContain('more credits')
  expect(getStatus().rotation.find(entry => entry.model === 'm2')?.outOfUsage).toBeNull()
  expect(modelOf('a')).toBe('m2')
})

it('forgets out-of-usage marks when counts are reset', async () => {
  applyRotation([{ provider: 'one', model: 'm1' }])
  await drain(spentProvider({ provider: 'one', model: 'm1' }))
  expect(getStatus().rotation[0]?.outOfUsage).not.toBeNull()
  resetRotationUsage()
  expect(getStatus().rotation[0]?.outOfUsage).toBeNull()
})

it('keeps rotation groups separate across sessions and skips exhausted members', async () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }, { provider: 'three', model: 'm3' }])
  applyRotationGroups([
    { name: 'deepseek', entries: [{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }] },
    { name: 'glm', entries: [{ provider: 'three', model: 'm3' }] }
  ])
  const [deepseek, glm] = getStatus().rotationGroups
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  createSession({ sessionId: 'b', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)
  applyRotationGroup(deepseek!.id, 'a')
  applyRotationGroup(glm!.id, 'b')
  expect(['m1', 'm2']).toContain(modelOf('a'))
  expect(modelOf('b')).toBe('m3')
  await drain(spentProvider({ provider: 'one', model: 'm1' }))
  expect(modelOf('a')).toBe('m2')
  expect(modelOf('b')).toBe('m3')
  expect(getStatus().sessions.a?.rotationGroup).toBe(deepseek!.id)
  expect(getStatus().sessions.b?.rotationGroup).toBe(glm!.id)
})

it('rotates only over the group in use, and every session follows a group change at once', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }, { provider: 'three', model: 'm3' }])
  applyRotationGroups([
    { name: 'code only', entries: [{ provider: 'two', model: 'm2' }, { provider: 'three', model: 'm3' }] },
    { name: 'media only', entries: [{ provider: 'one', model: 'm1' }] }
  ])
  const [code, media] = getStatus().rotationGroups
  expect(code?.name).toBe('code only')
  expect(code?.id).toBeTruthy()
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)

  applyRotationGroup(code!.id)
  expect(getStatus().rotationGroup).toBe(code!.id)
  const seen = new Set([modelOf('a'), modelOf('a'), modelOf('a'), modelOf('a')])
  expect([...seen].sort()).toEqual(['m2', 'm3'])
  expect(modelLabel(getStatus('a'))).toMatch(/^rotate · code only · m[23]$/)

  // Switching group lets go of the model the session was on: the chip names
  // the new group straight away, and the next prompt goes to one of its models.
  applyRotationGroup(media!.id)
  expect(modelLabel(getStatus('a'))).toBe('rotate · media only')
  expect(modelOf('a')).toBe('m1')

  // Back to the whole pool.
  applyRotationGroup(null)
  expect(modelLabel(getStatus('a'))).toBe('rotate')
})

it('adds a model a group names to the pool, and drops it from groups when it leaves the pool', () => {
  applyRotation([{ provider: 'one', model: 'm1' }])
  applyRotationGroups([{ name: 'reasoning', entries: [{ provider: 'two', model: 'm2' }] }])
  expect(getStatus().rotation.map((entry) => entry.model)).toEqual(['m1', 'm2'])
  applyRotation([{ provider: 'one', model: 'm1' }])
  expect(getStatus().rotationGroups[0]?.entries).toEqual([])
})

it('rotates a group linked to a provider over every model of it switched on, now and later', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }, { provider: 'two', model: 'm2b' }])
  applyRotationGroups([{ name: 'Two', entries: [], providers: ['two'] }])
  const group = getStatus().rotationGroups[0]!
  expect(group.providers).toEqual(['two'])
  expect(group.entries.map((entry) => entry.model)).toEqual(['m2', 'm2b'])

  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)
  applyRotationGroup(group.id)
  const seen = new Set([modelOf('a'), modelOf('a'), modelOf('a'), modelOf('a')])
  expect([...seen].sort()).toEqual(['m2', 'm2b'])

  // A link, not a copy: switched on later, a model joins; switched off, it leaves.
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2b' }, { provider: 'two', model: 'm2c' }])
  expect(getStatus().rotationGroups[0]?.entries.map((entry) => entry.model)).toEqual(['m2b', 'm2c'])
})

it('keeps a provider link when a group comes back with its models spelled out and no links', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  applyRotationGroups([{ name: 'mixed', entries: [{ provider: 'one', model: 'm1' }], providers: ['two'] }])
  // What an older client sends back: the resolved list, no `providers`.
  const shown = getStatus().rotationGroups[0]!
  applyRotationGroups([{ id: shown.id, name: 'mixed', entries: shown.entries }])
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }, { provider: 'two', model: 'm2b' }])
  const after = getStatus().rotationGroups[0]!
  expect(after.providers).toEqual(['two'])
  expect(after.entries.map((entry) => entry.model)).toEqual(['m1', 'm2', 'm2b'])

  // Unlinked the way Settings does it — hand-picked models only — the
  // provider's models leave with the link.
  const picked = after.entries.filter((entry) => !after.providers.includes(entry.provider))
  applyRotationGroups([{ id: after.id, name: 'mixed', entries: picked, providers: [] }])
  expect(getStatus().rotationGroups[0]?.entries.map((entry) => entry.model)).toEqual(['m1'])
})

it('blocks Rotate while the group in use is empty, and falls back to the pool when it is removed', () => {
  applyRotation([{ provider: 'one', model: 'm1' }])
  applyRotationGroups([{ name: 'media only', entries: [] }])
  applyRotationEnabled(true)
  applyRotationGroup(getStatus().rotationGroups[0]!.id)
  expect(getStatus()).toMatchObject({ providerReady: false })
  expect(getStatus().blockedReason).toMatch(/media only/)
  applyRotationGroups([])
  expect(getStatus()).toMatchObject({ rotationGroup: null, providerReady: true })
})


it('routes subscriptions internally and never falls back into a metered pool entry', () => {
  applyRotation([{ provider: 'three', model: 'm3' }])
  applySubscriptionRouting(true)
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  expect(getStatus().subscriptionOnly).toBe(true)
  const agent = agentOf('a')
  expect(agent.provider.name).toBe('one')
  expect(agent.fallback?.(Object.assign(new Error('rate limited'), { scope: 'account', retryAt: Date.now() + 60_000 }))).toMatchObject({ name: 'two' })
  expect(() => agent.fallback?.(Object.assign(new Error('usage limit reached'), { scope: 'account' }))).toThrow(/usage limit/)
  expect(getStatus().rotation.find((entry) => entry.provider === 'three')?.ready).toBe(false)
})

it('skips each forbidden inference route once within the subscription pool, never metered entries', () => {
  applyRotation([{ provider: 'three', model: 'm3' }])
  applySubscriptionRouting(true)
  createSession({ sessionId: 'forbidden', mode: 'chat', workspaceRoot: null })
  const agent = agentOf('forbidden')
  const refusal = Object.assign(new Error('Forbidden'), { status: 403 })
  expect(agent.provider.name).toBe('one')
  // Provider one explicitly offers two routes; rejection is model-scoped.
  expect(agent.fallback?.(refusal)).toMatchObject({ name: 'one', model: 'm1b' })
  expect(agent.fallback?.(refusal)).toMatchObject({ name: 'two' })
  expect(() => agent.fallback?.(refusal)).toThrow('Forbidden')
  expect(getStatus().rotation.find(entry => entry.provider === 'three')?.ready).toBe(false)
})

it('retains the configured pool when native subscription routing is switched off', () => {
  applyRotation([{ provider: 'three', model: 'm3' }])
  applySubscriptionRouting(true)
  applySubscriptionRouting(false)
  expect(getStatus()).toMatchObject({ subscriptionOnly: false, rotationEnabled: false })
  expect(getStatus().rotation.some((entry) => entry.provider === 'three')).toBe(true)
})


it('adds a new eligible login to an enabled native pool without discarding existing choices', () => {
  applySubscriptionRouting(true)
  applyRotation([{ provider: 'one', model: 'm1' }])
  syncAuthAccountRoutes('two')
  const pool = getStatus().rotation.map(entry => ({ provider: entry.provider, model: entry.model }))
  expect(pool).toContainEqual({ provider: 'one', model: 'm1' })
  expect(pool).toContainEqual({ provider: 'two', model: 'm2' })
  syncAuthAccountRoutes('two')
  expect(getStatus().rotation.filter(entry => entry.provider === 'two')).toHaveLength(1)
  applySubscriptionRouting(false)
})

it('allows bounded in-run retry after a single account transport failure instead of throwing during fallback', () => {
  extra.providers=[{id:'auth:codex-only',label:'Codex',kind:'auth',authKind:'codex',models:['same'],defaultModel:'same',credentialAvailable:true,configured:true,credentialHint:'',composerVisible:true}]
  createSession({sessionId:'single-transport',mode:'chat',workspaceRoot:null})
  selectProvider({provider:'auth:codex-only',model:'same'},'single-transport')
  const agent=agentOf('single-transport')
  expect(agent.fallback?.(new Error('fetch failed'))).toBeNull()
  expect(agentOf('single-transport').provider.name).toBe('auth:codex-only')
})

it('leaves rotation for the picked session only, and the others keep rotating', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  createSession({ sessionId: 'b', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)
  expect(getStatus('a').provider).toBe(ROTATE_PROVIDER)

  selectProvider({ provider: 'three', model: 'm3' }, 'a')
  // Session a now runs the model the user picked, session b stays on the pool,
  // and the pool itself is untouched.
  expect(getStatus('a')).toMatchObject({ provider: 'three', model: 'm3' })
  expect(getStatus('b').provider).toBe(ROTATE_PROVIDER)
  expect(getStatus().rotationEnabled).toBe(true)

  // The pick is also the fallback other sessions land on once rotation is off.
  applyRotationEnabled(false)
  expect(getStatus('b')).toMatchObject({ provider: 'three', model: 'm3' })
})

it('lets a draft ask for the pool even when a model was last picked', () => {
  applyRotation([{ provider: 'one', model: 'm1' }])
  selectProvider({ provider: 'three', model: 'm3' })
  expect(getStatus().provider).toBe('three')
  applyRotationEnabled(true)
  expect(getStatus().provider).toBe(ROTATE_PROVIDER)

  // The dashboard draft has no session behind it; picking Rotate there is the
  // only way back to the pool without touching an open session.
  selectProvider({ provider: ROTATE_PROVIDER, model: '' })
  expect(getStatus().provider).toBe(ROTATE_PROVIDER)
})

it('keeps a model picked in a not-yet-created tab while Rotate usage is on', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  applyRotationEnabled(true)

  // The "+" tab exists only in the renderer; its pick must stay on its chip.
  selectProvider({ provider: 'three', model: 'm3' }, 'c')
  expect(getStatus('c')).toMatchObject({ provider: 'three', model: 'm3' })
  expect(getStatus().sessions.c).toMatchObject({ provider: 'three', model: 'm3' })
  // The default for other new tabs stays on the pool.
  expect(getStatus().provider).toBe(ROTATE_PROVIDER)

  createSession({ sessionId: 'c', mode: 'chat', workspaceRoot: null })
  expect(getStatus('c')).toMatchObject({ provider: 'three', model: 'm3' })
  expect(modelOf('c')).toBe('m3')
})

it('starts a new session on the pool even after another session picked a model', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  applyRotationEnabled(true)
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  selectProvider({ provider: 'three', model: 'm3' }, 'a')
  expect(getStatus('a')).toMatchObject({ provider: 'three', model: 'm3' })

  // A fresh tab picks Rotate (or keeps the default) and must not inherit m3.
  selectProvider({ provider: ROTATE_PROVIDER, model: '' }, 'b')
  createSession({ sessionId: 'b', mode: 'chat', workspaceRoot: null })
  expect(getStatus('b').provider).toBe(ROTATE_PROVIDER)
  expect(['m1', 'm2']).toContain(modelOf('b'))

  createSession({ sessionId: 'copy', mode: 'chat', workspaceRoot: null })
  expect(getStatus('copy').provider).toBe(ROTATE_PROVIDER)
  expect(['m1', 'm2']).toContain(modelOf('copy'))
})

it('never rewrites a model the user picked in a session when rotation is switched', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  createSession({ sessionId: 'b', mode: 'chat', workspaceRoot: null })
  selectProvider({ provider: 'three', model: 'm3' }, 'a')
  applyRotationEnabled(true)
  selectProvider({ provider: 'three', model: 'm3' }, 'a')

  applyRotationEnabled(false)
  // Toggling the switch touches the rotating session, not the pinned one.
  expect(getStatus('a')).toMatchObject({ provider: 'three', model: 'm3' })
  // Switching rotation back on moves the sessions that follow the default onto
  // the pool; a session with its own pick keeps it.
  applyRotationEnabled(true)
  expect(getStatus('a')).toMatchObject({ provider: 'three', model: 'm3' })
  expect(getStatus('b').provider).toBe(ROTATE_PROVIDER)

  // Picking Rotate in that session hands it back to the pool.
  selectProvider({ provider: ROTATE_PROVIDER, model: '' }, 'a')
  applyRotationEnabled(false)
  applyRotationEnabled(true)
  expect(getStatus('a').provider).toBe(ROTATE_PROVIDER)
})

it('puts a session back on the pool when Rotate is picked again', () => {
  applyRotation([{ provider: 'one', model: 'm1' }, { provider: 'two', model: 'm2' }])
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  applyRotationEnabled(true)
  selectProvider({ provider: 'three', model: 'm3' }, 'a')
  expect(getStatus('a').provider).toBe('three')
  expect(modelOf('a')).toBe('m3')

  selectProvider({ provider: ROTATE_PROVIDER, model: '' }, 'a')
  expect(getStatus('a').provider).toBe(ROTATE_PROVIDER)
  expect(['m1', 'm2']).toContain(modelOf('a'))
})

it('skips legacy Laguna-on-Claude entries before creating an adapter, including after repeated prompts', () => {
  const laguna = 'poolside/laguna-xs-2.1:free'
  extra.providers = [
    { id: 'auth:claude', kind: 'auth', authKind: 'claude', label: 'Claude', models: ['claude-sonnet-5-5'], defaultModel: 'claude-sonnet-5-5', credentialAvailable: true, configured: true, credentialHint: '' },
    { id: 'auth:cline', kind: 'auth', authKind: 'cline', label: 'Cline', billing: 'free', models: [laguna], defaultModel: laguna, credentialAvailable: true, configured: true, credentialHint: '' }
  ]
  applyRotation([{ provider: 'auth:claude', model: laguna }, { provider: 'auth:cline', model: laguna }])
  applyRotationEnabled(true)
  createSession({ sessionId: 'laguna', mode: 'chat', workspaceRoot: null })
  expect(getStatus().rotation[0]).toMatchObject({ ready: false, unavailableReason: expect.stringContaining('not offered by Claude') })
  for (let index = 0; index < 5; index++) expect(agentOf('laguna').provider).toMatchObject({ name: 'auth:cline', model: laguna })
  expect(() => selectProvider({ provider: 'auth:claude', model: laguna }, 'laguna')).toThrow('not offered by Claude')
  // Preserve the user's configuration for review instead of silently deleting it.
  expect(getStatus().rotation).toHaveLength(2)
})

it('tries another same-service account for an input allowance without quota cooldown or model changes', () => {
  const model = 'deepseek-v4.1-flash:free'
  extra.providers = [1, 2].map(index => ({ id: `auth:cline-${index}`, kind: 'auth', authKind: 'cline', label: 'Cline', models: [model], billing: 'free', defaultModel: model, credentialAvailable: true, configured: true, credentialHint: '' }))
  applyRotation(extra.providers.map(provider => ({ provider: provider.id, model })))
  createSession({ sessionId: 'a', mode: 'chat', workspaceRoot: null })
  selectProvider({ provider: extra.providers[0]!.id, model }, 'a')
  const agent = agentOf('a')
  expect(agent.fallback?.(new InputRequestLimitError(57245, 3299, true))).toMatchObject({ name: 'auth:cline-2', model })
  expect(getStatus().rotation[0]).toMatchObject({ outOfUsage: null, coolingUntil: null })
  expect(() => agent.fallback?.(new InputRequestLimitError(57245, 3299, true))).toThrow('3299')
})
