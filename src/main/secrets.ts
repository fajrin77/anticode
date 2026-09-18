import * as electron from 'electron'

/*
 * Secrets typed into Settings, API keys, an MCP server's tokens, are sealed
 * with the OS's secure storage (Keychain on macOS, DPAPI on Windows) before
 * they touch disk. Without secure storage nothing is written: the secret
 * works for this run and has to be entered again after a restart.
 */

export const SEALED_PREFIX = 'safe:v1:'

function storage(): typeof electron.safeStorage | null {
  const safe = (electron as { safeStorage?: typeof electron.safeStorage }).safeStorage
  try {
    return safe?.isEncryptionAvailable() === true ? safe : null
  } catch {
    return null
  }
}

export function secureStorageAvailable(): boolean {
  return storage() !== null
}

export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX)
}

/** Sealed for disk; '' when there is no secure storage to seal it with. */
export function seal(value: string): string {
  if (value === '' || isSealed(value)) return value
  const safe = storage()
  return safe === null ? '' : `${SEALED_PREFIX}${safe.encryptString(value).toString('base64')}`
}

/** The secret itself; a plaintext value from an older file passes through. */
export function unseal(value: string): string {
  if (!isSealed(value)) return value
  const safe = storage()
  if (safe === null) return ''
  try {
    return safe.decryptString(Buffer.from(value.slice(SEALED_PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}
