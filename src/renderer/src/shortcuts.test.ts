import { beforeEach, expect, it } from 'vitest'
import { useSessionStore } from './store/session'
import { SHORTCUT_GROUPS, keyLabel, latestReply, neighbourSession, sessionOrder } from './shortcuts'

beforeEach(() => {
  useSessionStore.setState({ sessions: [], projectOrder: [], activeSessionId: null })
})

it('orders sessions the way the sidebar groups them, without archived tabs', () => {
  const store = useSessionStore.getState()
  const a1 = store.openSession('code', '/a')
  const b1 = store.openSession('code', '/b')
  const a2 = store.openSession('code', '/a')
  const archived = store.openSession('code', '/b')
  store.syncProjectOrder()
  useSessionStore.getState().closeSession(archived)
  expect(sessionOrder(useSessionStore.getState()).map((session) => session.id)).toEqual([a1, a2, b1])
})

it('steps to the next and previous session, wrapping around', () => {
  const store = useSessionStore.getState()
  const ids = ['/a', '/a', '/a'].map((root) => store.openSession('code', root))
  const order = sessionOrder(useSessionStore.getState())
  expect(neighbourSession(order, ids[2]!, 1)).toBe(ids[0])
  expect(neighbourSession(order, ids[0]!, -1)).toBe(ids[2])
  expect(neighbourSession(order, null, 1)).toBe(ids[0])
  expect(neighbourSession(order.slice(0, 1), ids[0]!, 1)).toBeNull()
})

it('copies the final words of the latest finished reply', () => {
  const store = useSessionStore.getState()
  const id = store.openSession('chat', null)
  store.addMessage({ id: 'u', role: 'user', parts: [{ kind: 'text', text: 'halo' }], pending: false }, id)
  store.addMessage({ id: 'a', role: 'assistant', parts: [{ kind: 'text', text: 'working notes' }, { kind: 'text', text: 'Final answer.' }], pending: false }, id)
  store.addMessage({ id: 'p', role: 'assistant', parts: [], pending: true }, id)
  expect(latestReply(useSessionStore.getState().sessions.find((session) => session.id === id))).toBe('Final answer.')
})

it('lists every shortcut once and spells keys for each platform', () => {
  const actions = SHORTCUT_GROUPS.flatMap((group) => group.items.map((item) => item.action))
  expect(new Set(actions).size).toBe(actions.length)
  expect(keyLabel('Mod', true)).toBe('⌘')
  expect(keyLabel('Mod', false)).toBe('Ctrl')
  expect(keyLabel('Shift', true)).toBe('⇧')
})
