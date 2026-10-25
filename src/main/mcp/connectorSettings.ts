import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export interface ConnectorSettings { codex: boolean; claude: boolean }
let cached: ConnectorSettings | undefined
export function getConnectorSettings(): ConnectorSettings {
  if (!cached) {
    let stored: Partial<ConnectorSettings> = {}
    try { stored = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'connector-settings.json'), 'utf8')) } catch { /* defaults */ }
    cached = { codex: stored?.codex !== false, claude: stored?.claude === true }
  }
  return { ...cached }
}
export function setConnectorSettings(input: unknown): ConnectorSettings {
  if (!input || typeof input !== 'object') throw new Error('Expected connector settings')
  const value = input as ConnectorSettings
  if (typeof value.codex !== 'boolean' || typeof value.claude !== 'boolean') throw new Error('Expected on or off for each connector')
  const next = { codex: value.codex, claude: value.claude }
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(path.join(app.getPath('userData'), 'connector-settings.json'), JSON.stringify(next), { mode: 0o600 })
  cached = next
  return { ...next }
}
