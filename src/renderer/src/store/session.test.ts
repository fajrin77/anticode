import { beforeEach, expect, it } from 'vitest'
import { useSessionStore } from './session'
import type { SnapshotMessage } from '@shared/ipc'
import { FOLLOW_UP_LABEL } from '../labels'
beforeEach(() => useSessionStore.setState({ sessions: [], activeRuns: {}, mirrorRuns: {}, activeSessionId: null, planOpenBySession: {} }))

it('keeps the Plan fold state separate for each session', () => {
  const store = useSessionStore.getState()
  store.setPlanOpen('one', false)
  store.setPlanOpen('two', true)
  expect(useSessionStore.getState().planOpenBySession).toEqual({ one: false, two: true })
})
it('restores tool failures across message boundaries and omits empty user bubbles', () => {
  const store = useSessionStore.getState(); const id = store.openSession('chat', null)
  store.importSnapshot(id, [
    { role: 'assistant', blocks: [{ type: 'tool_use', id: 't', name: 'write_file', input: {} }] },
    { role: 'user', blocks: [{ type: 'tool_result', toolUseId: 't', content: 'disk full', isError: true }] }
  ])
  const messages = useSessionStore.getState().sessions[0]!.messages
  expect(messages).toHaveLength(1)
  expect(messages[0]!.parts[0]).toMatchObject({ status: 'error', output: 'disk full' })
})
it('settles one desktop run without losing another', () => {
  const store = useSessionStore.getState()
  store.setActiveRun({ runId: 'a', sessionId: 'one', messageId: 'm1', startedAt: 0 })
  store.setActiveRun({ runId: 'b', sessionId: 'two', messageId: 'm2', startedAt: 0 })
  store.setActiveRun(null, 'a')
  expect(Object.keys(useSessionStore.getState().activeRuns)).toEqual(['b'])
})

it('moves a run on to a fresh reply when a follow-up joins it', () => {
  const store = useSessionStore.getState()
  const id = store.openSession('chat', null)
  store.addMessage({ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'kerjakan' }], pending: false })
  store.addMessage({ id: 'a1', role: 'assistant', parts: [], pending: true })
  store.setActiveRun({ runId: 'r', sessionId: id, messageId: 'a1', startedAt: 0 })
  store.startTool(id, 'a1', 't1', 'read_file', {})

  store.steerRun('r', id, 'tambah ini')
  // Shown at once, under the reply — which keeps streaming above it until the
  // run takes the instruction in.
  const queued = useSessionStore.getState().sessions[0]!.messages
  expect(queued.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  expect(useSessionStore.getState().activeRuns['r']!.messageId).toBe('a1')
  store.appendText(id, 'a1', 'masih jawaban lama')
  expect(useSessionStore.getState().sessions[0]!.messages[1]!.parts.at(-1)).toEqual({ kind: 'text', text: 'masih jawaban lama' })

  store.takeSteer('r', id)

  const state = useSessionStore.getState()
  const messages = state.sessions[0]!.messages
  expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'assistant'])
  expect(messages[1]).toMatchObject({ id: 'a1', pending: false })
  expect(messages[2]!.parts).toEqual([{ kind: 'text', text: 'tambah ini' }])
  expect(messages[3]!.parts).toEqual([{ kind: 'notice', text: FOLLOW_UP_LABEL }])
  expect(messages[4]!.pending).toBe(true)
  expect(state.activeRuns['r']!.messageId).toBe(messages[4]!.id)

  // A step the earlier reply started still settles where it was drawn.
  store.endTool(id, messages[4]!.id, 't1', true, 'isi')
  expect(useSessionStore.getState().sessions[0]!.messages[1]!.parts[0]).toMatchObject({ status: 'ok', output: 'isi' })
})

it('restores a follow-up with its marker, and keeps closing lines on the turns that ended runs', () => {
  const store = useSessionStore.getState()
  const id = store.openSession('chat', null)
  store.importSnapshot(
    id,
    [
      { role: 'user', blocks: [{ type: 'text', text: 'pertama' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'jawaban satu' }] },
      { role: 'user', blocks: [{ type: 'text', text: 'kedua' }] },
      { role: 'assistant', blocks: [{ type: 'tool_use', id: 't', name: 'read_file', input: {} }] },
      {
        role: 'user',
        blocks: [
          { type: 'tool_result', toolUseId: 't', content: 'isi', isError: false },
          { type: 'text', text: 'tambah ini', followUp: 'during' }
        ]
      },
      { role: 'assistant', blocks: [{ type: 'text', text: 'dua-duanya beres' }] }
    ],
    [
      { model: 'm', durationMs: 1, inputTokens: 1, outputTokens: 1 },
      { model: 'm', durationMs: 2, inputTokens: 2, outputTokens: 2 }
    ]
  )
  const messages = useSessionStore.getState().sessions[0]!.messages
  const shape = messages.map((message) =>
    message.parts.map((part) => (part.kind === 'text' || part.kind === 'notice' ? `${part.kind}:${part.text}` : part.kind)).join('|')
  )
  expect(shape).toEqual([
    'text:pertama',
    'text:jawaban satu',
    'text:kedua',
    'tool',
    'text:tambah ini',
    `notice:${FOLLOW_UP_LABEL}`,
    'text:dua-duanya beres'
  ])
  // Two runs, two closing lines: the first answer and the reply after the
  // follow-up. The turn the follow-up interrupted has none.
  expect(messages.map((message) => message.summary?.durationMs ?? null)).toEqual([null, 1, null, null, null, null, 2])
})

it('keeps closing lines stamped live when a re-import carries fewer summaries', () => {
  const store = useSessionStore.getState()
  const id = store.openSession('chat', null)
  const snapshot: SnapshotMessage[] = [
    { role: 'user', blocks: [{ type: 'text', text: 'pertama' }] },
    { role: 'assistant', blocks: [{ type: 'text', text: 'jawaban satu' }] },
    { role: 'user', blocks: [{ type: 'text', text: 'kedua' }] },
    { role: 'assistant', blocks: [{ type: 'text', text: 'jawaban dua' }] }
  ]
  store.importSnapshot(id, snapshot, [
    { model: 'm', durationMs: 1, inputTokens: 1, outputTokens: 1 },
    { model: 'm', durationMs: 2, inputTokens: 2, outputTokens: 2 }
  ])
  // A re-import whose archive lost the old lines (trimmed, shifted) must not
  // strip the closing lines the window already stamped.
  store.importSnapshot(id, snapshot, [
    { model: 'm', durationMs: 2, inputTokens: 2, outputTokens: 2 }
  ])
  const durations = useSessionStore.getState().sessions[0]!.messages.map((message) => message.summary?.durationMs ?? null)
  expect(durations).toEqual([null, 1, null, 2])
})

it('takes the colour the main process settled on for a session it already knows', () => {
  const store = useSessionStore.getState()
  const id = store.openSession('code', '/tmp/proyek')
  store.addExternalSession({ sessionId: id, mode: 'code', workspaceRoot: '/tmp/proyek', colour: 7 })
  expect(useSessionStore.getState().sessions[0]!.colour).toBe(7)
})

it('does not count token usage twice when a live snapshot replays the same event', () => {
  useSessionStore.setState({ usage: [], seenUsageEvents: [] })
  const store = useSessionStore.getState()
  const id = store.openSession('chat', null)
  store.addUsage(id, 'test', 'model', 20, 10, 'run:12', false, 0.5)
  store.addUsage(id, 'test', 'model', 20, 10, 'run:12', false, 0.5)
  expect(useSessionStore.getState().usage).toEqual([{ provider: 'test', model: 'model', inputTokens: 20, outputTokens: 10, costUsd: 0.5 }])
  expect(useSessionStore.getState().sessions[0]?.inputTokens).toBe(20)
  expect(useSessionStore.getState().sessions[0]?.costUsd).toBe(0.5)
})

it('counts only typed prompts: a resume reads as its marker and a follow-up rides along', async () => {
  const { CONTINUE_PROMPT } = await import('@shared/ipc')
  const { RESUME_LABEL } = await import('../labels')
  const { isTypedPrompt } = await import('./session')
  const store = useSessionStore.getState()
  const id = store.openSession('chat', null)
  store.importSnapshot(id, [
    { role: 'user', blocks: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', blocks: [{ type: 'text', text: 'one' }] },
    { role: 'user', blocks: [{ type: 'text', text: 'also this', followUp: 'after' }] },
    { role: 'user', blocks: [{ type: 'text', text: CONTINUE_PROMPT }] },
    { role: 'assistant', blocks: [{ type: 'text', text: 'two' }] }
  ])
  const messages = useSessionStore.getState().sessions[0]!.messages
  expect(messages.some((message) => message.parts.some((part) => part.kind === 'notice' && part.text === RESUME_LABEL))).toBe(true)
  expect(messages.filter(isTypedPrompt).map((message) => message.parts.find((part) => part.kind === 'text'))).toEqual([
    { kind: 'text', text: 'first' }
  ])

  store.dropFrom(id, messages[1]!.id)
  expect(useSessionStore.getState().sessions[0]!.messages).toHaveLength(1)
})
