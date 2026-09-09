import { beforeEach, expect, it } from 'vitest'
import { useSessionStore } from './session'
beforeEach(() => useSessionStore.setState({ sessions: [], activeRuns: {}, mirrorRuns: {}, activeSessionId: null }))
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
