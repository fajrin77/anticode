import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import type { CredentialStatus, EnvCredential } from '@shared/ipc'
import { envFilePath } from './config'
import { clinepassConfig, editClinepass } from './providers/clinepass'
import { listCustomProviders } from './providers/custom'
import { secureStorageAvailable } from './secrets'

/*
 * Keys typed into Settings are sealed with the OS keychain; keys in the .env
 * file are the user's own plaintext file, and anticode never rewrites it on
 * its own. What it can do is say so: which secrets that file holds, whether
 * other accounts can read it, and — when asked — move the keys it uses into
 * sealed storage and take them out of the file.
 */

/** Variables that hold something secret, going by their names. */
const SECRET_NAME = /(API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD)$/i

/** The keys anticode itself reads, and how each moves into sealed storage. */
const MOVABLE: Record<string, { usedBy: string; move: (value: string) => void }> = {
  CLINEPASS_API_KEY: { usedBy: 'Clinepass', move: (value) => editClinepass({ apiKey: value }) }
}

interface EnvLine {
  index: number
  name: string
  value: string
}

/** `KEY=value`, `export KEY="value"`; comments and blank lines are skipped. */
export function parseEnv(text: string): EnvLine[] {
  const lines: EnvLine[] = []
  text.split('\n').forEach((line, index) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match === null) return
    let value = match[2] ?? ''
    const quoted = /^(['"])(.*)\1$/.exec(value)
    if (quoted !== null) value = quoted[2] ?? ''
    else value = value.replace(/\s+#.*$/, '')
    lines.push({ index, name: match[1] ?? '', value })
  })
  return lines
}

export function mask(value: string): string {
  if (value.length <= 12) return '•'.repeat(Math.min(8, Math.max(4, value.length)))
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

/** Everyone but the owner is shut out: group and other bits all clear. */
function openToOthers(file: string): boolean {
  if (process.platform === 'win32') return false
  try {
    return (statSync(file).mode & 0o077) !== 0
  } catch {
    return false
  }
}

/**
 * Every secret value this app holds — keys typed in Settings, the Clinepass
 * key, secret-looking environment variables, MCP tokens — so an export can
 * mask them wherever they turn up in a transcript.
 */
export function knownSecrets(extra: string[] = []): string[] {
  const values = [
    ...listCustomProviders().map((provider) => provider.apiKey),
    clinepassConfig().apiKey ?? '',
    ...Object.entries(process.env).filter(([name]) => SECRET_NAME.test(name)).map(([, value]) => value ?? ''),
    ...extra
  ]
  // Longest first, so a key that contains a shorter one is masked whole.
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length >= 8))].sort((a, b) => b.length - a.length)
}

export function credentialStatus(): CredentialStatus {
  const file = envFilePath()
  let keys: EnvCredential[] = []
  if (file !== null) {
    try {
      keys = parseEnv(readFileSync(file, 'utf8'))
        .filter((line) => SECRET_NAME.test(line.name) && line.value !== '')
        .map((line) => ({
          name: line.name,
          masked: mask(line.value),
          usedBy: MOVABLE[line.name]?.usedBy ?? null,
          movable: MOVABLE[line.name] !== undefined
        }))
    } catch { /* The file went away since start-up; nothing to report. */ }
  }
  return {
    secureStorage: secureStorageAvailable(),
    envFile: file,
    envFileOpen: file !== null && openToOthers(file),
    envKeys: keys
  }
}

/**
 * Seals the keys anticode uses and comments their lines out of the .env
 * file, leaving everything else in it as it was. Refused without secure
 * storage: the key would be gone from the file and not saved anywhere.
 */
export function moveEnvKeys(): CredentialStatus {
  const file = envFilePath()
  if (file === null) throw new Error('No .env file was loaded')
  if (!secureStorageAvailable()) throw new Error('This system has no secure storage to move the keys into')
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const today = new Date().toISOString().slice(0, 10)
  let moved = 0
  for (const line of parseEnv(text)) {
    const target = MOVABLE[line.name]
    if (target === undefined || line.value === '') continue
    target.move(line.value)
    lines[line.index] = `# ${line.name} moved to anticode's secure storage on ${today}`
    delete process.env[line.name]
    moved += 1
  }
  if (moved > 0) {
    const mode = statSync(file).mode & 0o777
    writeFileSync(`${file}.tmp`, lines.join('\n'), { mode })
    renameSync(`${file}.tmp`, file)
  }
  return credentialStatus()
}

/** Only the owner may read the .env file from now on. */
export function restrictEnvFile(): CredentialStatus {
  const file = envFilePath()
  if (file === null) throw new Error('No .env file was loaded')
  chmodSync(file, 0o600)
  return credentialStatus()
}
