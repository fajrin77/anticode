import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
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
  rotation?: PersistedRotation
}

export interface PersistedRotation {
  entries: { provider: string; model: string }[]
  /** Tokens per entry since the last reset, keyed by rotationKey. */
  usage: Record<string, { inputTokens: number; outputTokens: number }>
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
    mkdirSync(path.dirname(file()), { recursive: true })
    writeFileSync(`${file()}.tmp`, JSON.stringify(cache, null, 2), { mode: 0o600 })
    renameSync(`${file()}.tmp`, file())
  } catch {
    // Persistence is best-effort; the app works with defaults without it.
  }
}
