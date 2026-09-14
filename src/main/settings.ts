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
  /** `${sessionId}:${toolName}` grants from "Always allow", kept across restarts. */
  alwaysAllowed?: string[]
  /** Ride along with a running task, or wait in line. One source for both screens. */
  followUpMode?: 'steer' | 'queue'
  provider?: string | null
  model?: string | null
  remote?: RemoteSettings
  rotation?: PersistedRotation
  updates?: { source: string; autoCheck: boolean; autoDownload: boolean }
  preferences?: Partial<Omit<import('@shared/ipc').AppPreferences, 'notifications'>> & {
    notifications?: Partial<import('@shared/ipc').NotificationSettings>
  }
  /** Prices typed in Settings → Pricing, dollars per million tokens, by model id. */
  pricing?: Record<string, import('@shared/ipc').ModelPrice>
}

export interface PersistedRotation {
  /** Switched on in Settings; absent means off. */
  enabled?: boolean
  entries: { provider: string; model: string }[]
  /** Tokens per entry since the last reset, keyed by rotationKey. */
  usage: Record<string, { inputTokens: number; outputTokens: number }>
  /** Named parts of the pool; absent means none were made. */
  groups?: { id: string; name: string; entries: { provider: string; model: string }[]; providers?: string[] }[]
  /** The group in use; absent or null means the whole pool. */
  group?: string | null
  /** Entries whose quota ran out, keyed by rotationKey. */
  outOfUsage?: Record<string, { since: number; reason: string }>
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
