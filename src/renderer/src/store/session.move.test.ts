import { describe, expect, it, beforeEach } from 'vitest'
import { useSessionStore } from './session'

/** Fresh store per test: sessions are the only state moveSession touches. */
function seed(titles: string[]): string[] {
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  return titles.map((title) => {
    const id = useSessionStore.getState().openSession('code', null)
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title, messages: [{ id: 'm', role: 'user', parts: [], at: 1 }] } : session
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
    const [a, b, c] = seed(['a', 'b', 'c'])
    useSessionStore.getState().closeSession(b)
    useSessionStore.getState().moveSession(c, 'left')
    const titles = useSessionStore
      .getState()
      .sessions.filter((session) => !session.closed)
      .map((session) => session.title)
    expect(titles).toEqual(['c', 'a'])
    expect(a).toBeDefined()
  })

  it('does nothing at the edges', () => {
    const [a, b] = seed(['a', 'b'])
    useSessionStore.getState().moveSession(a, 'left')
    useSessionStore.getState().moveSession(b, 'right')
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
