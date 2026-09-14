import { describe, expect, it, beforeEach } from 'vitest'
import { useSessionStore, type Session } from './session'

/** Fresh store per test: sessions are the only state moveSession touches. */
function seed(titles: string[]): string[] {
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  return titles.map((title) => {
    const id = useSessionStore.getState().openSession('code', null)
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session): Session =>
        session.id === id
          ? {
              ...session,
              title,
              messages: [
                { id: 'm', role: 'user' as const, parts: [], pending: false }
              ]
            }
          : session
      )
    }))
    return id
  })
}

describe('moveSession', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], activeSessionId: null })
  })

  it('swaps a tab with its left neighbour, leaving closed sessions in place', () => {
    const ids = seed(['a', 'b', 'c'])
    useSessionStore.getState().closeSession(ids[1]!)
    useSessionStore.getState().moveSession(ids[2]!, 'left')
    const titles = useSessionStore
      .getState()
      .sessions.filter((session) => !session.closed)
      .map((session) => session.title)
    expect(titles).toEqual(['c', 'a'])
  })

  it('does nothing at the edges', () => {
    const ids = seed(['a', 'b'])
    useSessionStore.getState().moveSession(ids[0]!, 'left')
    useSessionStore.getState().moveSession(ids[1]!, 'right')
    const titles = useSessionStore.getState().sessions.map((session) => session.title)
    expect(titles).toEqual(['a', 'b'])
  })

  it('moves right across the open-tab order', () => {
    seed(['a', 'b', 'c'])
    const [first] = useSessionStore.getState().sessions
    useSessionStore.getState().moveSession(first!.id, 'right')
    const titles = useSessionStore.getState().sessions.map((session) => session.title)
    expect(titles).toEqual(['b', 'a', 'c'])
  })
})
