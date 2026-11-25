import { app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_MODEL = 'claude-opus-5'

/**
 * Dev reads .env from the project root; a packaged app launched from Finder
 * or the Dock runs with cwd = '/', so there the credentials live in the
 * per-user application-data directory instead.
 */
let loadedEnvFile: string | null = null
const injectedEnvKeys = new Set<string>()

/** The env file credentials were read from at start-up, if any. */
export function envFilePath(): string | null {
  return loadedEnvFile
}

/** Keys injected by Anticode's own .env file, stripped from workspace child shells. */
export function anticodeEnvKeys(): ReadonlySet<string> {
  return injectedEnvKeys
}

export function loadEnvFile(): void {
  const candidates = app.isPackaged
    ? [path.join(app.getPath('userData'), '.env')]
    : [path.join(process.cwd(), '.env'), path.join(app.getPath('userData'), '.env')]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const before = new Set(Object.keys(process.env))
      process.loadEnvFile(candidate)
      for (const key of Object.keys(process.env)) {
        if (!before.has(key)) injectedEnvKeys.add(key)
      }
      loadedEnvFile = candidate
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
