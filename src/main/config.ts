import { existsSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_MODEL = 'claude-opus-5'

/** Dev convenience: keys live in the OS credential store once packaging lands. */
export function loadEnvFile(): void {
  const candidate = path.join(process.cwd(), '.env')
  if (!existsSync(candidate)) return
  try {
    process.loadEnvFile(candidate)
  } catch (error) {
    console.warn(`Gagal membaca .env: ${(error as Error).message}`)
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
