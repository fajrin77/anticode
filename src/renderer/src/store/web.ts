import { create } from 'zustand'
import type { WebSession } from '@shared/ipc'

/**
 * Mirror of the main process's browser panes. Nothing is persisted here: the
 * agent is what opens pages, so the main process is the only honest owner of
 * this state and it survives a restart on its own.
 */
interface WebState {
  sessions: WebSession[]
  setSessions: (sessions: WebSession[]) => void
}

export const useWebStore = create<WebState>()((set) => ({
  sessions: [],
  setSessions: (sessions) => set({ sessions })
}))

export function useWebSession(sessionId: string | null): WebSession | undefined {
  return useWebStore((state) =>
    sessionId === null
      ? undefined
      : state.sessions.find((entry) => entry.sessionId === sessionId)
  )
}
