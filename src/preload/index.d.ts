import type { AnticodeApi } from '../shared/ipc'
import type { SessionState } from '../renderer/src/store/session'

declare global {
  interface Window {
    anticode: AnticodeApi
    /** Debugging hook for CDP inspection. */
    __store?: { getState: () => SessionState }
  }
}

export {}
