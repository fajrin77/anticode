import { app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_MODEL = 'claude-opus-5'

/**
 * Dev reads .env from the project root; a packaged app launched from Finder
 * or the Dock runs with cwd = '/', so there the credentials live in the
 * per-user application-data directory instead.
 */
export function loadEnvFile(): void {
  const candidates = app.isPackaged
    ? [path.join(app.getPath('userData'), '.env')]
    : [path.join(process.cwd(), '.env'), path.join(app.getPath('userData'), '.env')]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      process.loadEnvFile(candidate)
      return
    } catch (error) {
      console.warn(`Failed to read ${candidate}: ${(error as Error).message}`)
    }
  }
}

export function getApiKey(): string | null {
  const key = process.env['ANTHROPIC_API_KEY']?.trim()
  return key !== undefined && key !== '' ? key : null
}

export function getModel(): string {
  const model = process.env['ANTICODE_MODEL']?.trim()
  return model !== undefined && model !== '' ? model : DEFAULT_MODEL
}
