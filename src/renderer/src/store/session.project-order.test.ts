import { beforeEach, describe, expect, it } from 'vitest'
import { sidebarProjectOrder, useSessionStore } from './session'

beforeEach(() => {
  useSessionStore.setState({ sessions: [], projectOrder: [], activeSessionId: null })
})

function seed(): string[] {
  const ids = ['/a', '/b', '/a', '/c'].map((root) => useSessionStore.getState().openSession('code', root))
  useSessionStore.getState().syncProjectOrder()
  return ids
}

describe('sidebar project ordering', () => {
  it('keeps project order when its first session is deleted or archived', () => {
    const ids = seed()
    useSessionStore.getState().deleteSession(ids[0]!)
    useSessionStore.getState().closeSession(ids[2]!)
    expect(sidebarProjectOrder(useSessionStore.getState())).toEqual(['/a', '/b', '/c'])
  })

  it('moves projects above and below targets without changing session order', () => {
    const ids = seed()
    useSessionStore.getState().moveProject('/c', '/a', false)
    expect(useSessionStore.getState().projectOrder).toEqual(['/c', '/a', '/b'])
    useSessionStore.getState().moveProject('/c', '/b', true)
    expect(useSessionStore.getState().projectOrder).toEqual(['/a', '/b', '/c'])
    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(ids)
  })

  it('retains hidden project positions and appends newly discovered groups', () => {
    const ids = seed()
    useSessionStore.getState().moveProject('/c', '/a', false)
    useSessionStore.getState().deleteSession(ids[1]!)
    useSessionStore.getState().openSession('code', '/b')
    useSessionStore.getState().openSession('chat', null)
    useSessionStore.getState().openSession('code', null)
    useSessionStore.getState().syncProjectOrder()
    expect(useSessionStore.getState().projectOrder).toEqual(['/c', '/a', '/b', 'antichat', ''])
  })

  it('ignores invalid moves and persists manual order across hydration', async () => {
    seed()
    useSessionStore.getState().moveProject('/missing', '/a', false)
    useSessionStore.getState().moveProject('/a', '/a', true)
    expect(useSessionStore.getState().projectOrder).toEqual(['/a', '/b', '/c'])
    useSessionStore.getState().moveProject('/c', '/a', false)
    const options = useSessionStore.persist.getOptions()
    const saved = JSON.stringify({ state: options.partialize!(useSessionStore.getState()) })
    useSessionStore.persist.setOptions({ storage: {
      getItem: () => JSON.parse(saved),
      setItem: () => {},
      removeItem: () => {}
    } })
    try {
      useSessionStore.setState({ projectOrder: [] })
      await useSessionStore.persist.rehydrate()
      expect(useSessionStore.getState().projectOrder).toEqual(['/c', '/a', '/b'])
    } finally {
      useSessionStore.persist.setOptions({ storage: options.storage })
    }
  })
})
