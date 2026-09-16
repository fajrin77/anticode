import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { seal, unseal, isSealed } from '../secrets'
import type { AuthAccount, AuthTokens } from './types'

/*
 * One JSON file in userData holds every auth account. The public half (id,
 * label, account, expiresAt) is plaintext so the UI can list accounts before
 * the keychain is unlocked; the tokens themselves are sealed with the OS
 * secure storage. Without a keychain we refuse to write tokens rather than
 * leave them in the clear — same rule as Settings → Providers.
 */

interface StoreShape {
  version: 1
  accounts: { account: AuthAccount; sealed: string }[]
}

let cache: StoreShape | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'auth-accounts.json')
}

function load(): StoreShape {
  if (cache !== null) return cache
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as StoreShape
    cache = raw?.version === 1 && Array.isArray(raw.accounts) ? raw : { version: 1, accounts: [] }
  } catch {
    cache = { version: 1, accounts: [] }
  }
  return cache
}

function persist(): void {
  if (cache === null) return
  try {
    mkdirSync(path.dirname(file()), { recursive: true })
    writeFileSync(`${file()}.tmp`, JSON.stringify(cache, null, 2), { mode: 0o600 })
    renameSync(`${file()}.tmp`, file())
  } catch {
    // Best-effort, same as settings.json.
  }
}

/** Just the public records, for the UI. */
export function listAuthAccounts(): AuthAccount[] {
  return load().accounts.map((entry) => entry.account)
}

export function getAuthAccount(id: string): AuthAccount | undefined {
  return load().accounts.find((entry) => entry.account.id === id)?.account
}

/** Every vendor + email pair currently stored, for label collision checks. */
export function authAccountExists(id: string): boolean {
  return load().accounts.some((entry) => entry.account.id === id)
}

/** Round-trips the sealed blob back to tokens; {} when the keychain is gone. */
export function readAuthTokens(id: string): AuthTokens | null {
  const entry = load().accounts.find((row) => row.account.id === id)
  if (entry === undefined) return null
  if (!isSealed(entry.sealed)) {
    // Older file from a build without secure storage: refuse rather than leak.
    return null
  }
  const raw = unseal(entry.sealed)
  if (raw === '') return null
  try {
    return JSON.parse(raw) as AuthTokens
  } catch {
    return null
  }
}

/** Adds or replaces one account, sealing its tokens. Throws without keychain. */
export function saveAuthAccount(account: AuthAccount, tokens: AuthTokens): void {
  const sealed = seal(JSON.stringify(tokens))
  if (sealed === '') {
    throw new Error(
      'Secure storage is not available, so the login could not be saved. ' +
        'Turn on FileVault (macOS) or the equivalent (Windows) and try again.'
    )
  }
  const store = load()
  const row = { account, sealed }
  const next = store.accounts.filter((entry) => entry.account.id !== account.id)
  next.push(row)
  cache = { version: 1, accounts: next }
  persist()
}

/**
 * Rewrites only the tokens of an existing account, keeping its public half.
 * The two facts the Settings list reads off the public half — when the token
 * dies and whether it can be renewed — are kept in step here, so a refresh
 * that drops the refresh token does not leave the UI promising one.
 */
export function updateAuthTokens(id: string, tokens: AuthTokens): void {
  const store = load()
  const entry = store.accounts.find((row) => row.account.id === id)
  if (entry === undefined) return
  const sealed = seal(JSON.stringify(tokens))
  if (sealed === '') return
  entry.sealed = sealed
  // A vendor that does not say when the token dies gets no expiry shown at
  // all; 0 would read as "expired in 1970".
  if (tokens.expiresAt === undefined || tokens.expiresAt === 0) delete entry.account.expiresAt
  else entry.account.expiresAt = tokens.expiresAt
  entry.account.refreshable = tokens.refreshToken !== undefined
  cache = { version: 1, accounts: store.accounts }
  persist()
}

/** Renames one account without touching its tokens. */
export function renameAuthAccount(id: string, label: string): void {
  const store = load()
  const entry = store.accounts.find((row) => row.account.id === id)
  if (entry === undefined) return
  entry.account.label = label
  cache = { version: 1, accounts: store.accounts }
  persist()
}

export function removeAuthAccount(id: string): void {
  const store = load()
  cache = {
    version: 1,
    accounts: store.accounts.filter((entry) => entry.account.id !== id)
  }
  persist()
}

/** For tests: drop the in-memory cache so the next call re-reads the file. */
export function resetAuthStoreForTests(): void {
  cache = null
}