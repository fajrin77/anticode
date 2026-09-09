import type { AnticodeApi } from '../shared/ipc'

declare global {
  interface Window {
    anticode: AnticodeApi
  }
}

export {}
