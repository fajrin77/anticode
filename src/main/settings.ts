import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface RemoteSettings {
  enabled: boolean
  token: string
  port: number
}

export interface PersistedSettings {
  autoApprove?: boolean
  provider?: string | null
  model?: string | null
  remote?: RemoteSettings
}

let cache: PersistedSettings | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

export function loadPersistedSettings(): PersistedSettings {
  if (cache !== null) return cache
  try {
    cache = JSON.parse(readFileSync(file(), 'utf8')) as PersistedSettings
  } catch {
    cache = {}
  }
  return cache
}

export function savePersistedSettings(patch: PersistedSettings): void {
  cache = { ...loadPersistedSettings(), ...patch }
  try {
    writeFileSync(file(), JSON.stringify(cache, null, 2), { mode: 0o600 })
  } catch {
    // Persistence is best-effort; the app works with defaults without it.
  }
}
