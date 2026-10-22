import { readFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { getCustomProvider, removeCustomProvider, cleanApiKeys } from '../providers/custom'
import { isDirectClinepassURL } from '../providers/clinepass'
import { getAuthAccount, readAuthTokens, saveAuthAccount } from './store'

/** Keep the old id so saved sessions, Composer choices and usage stay attached. */
export function migrateClinePassAccount(): void {
  const config = getCustomProvider('clinepass')
  if (!config || !isDirectClinepassURL(config.baseURL)) return
  const keys = cleanApiKeys([config.apiKey, ...(config.apiKeys ?? [])])
  if (!keys.length) return // Never remove an unreadable keychain entry.
  const ids: string[] = []
  for (const [index, key] of keys.entries()) {
    const id = index === 0 ? 'clinepass' : `auth:clinepass-import-${index + 1}`
    // Existing migrated slots are immutable; only remove the old copy once all match.
    const existing = getAuthAccount(id)
    if (existing && readAuthTokens(id)?.accessToken !== key) return
    if (!existing) saveAuthAccount({ id, kind: 'clinepass', label: keys.length > 1 ? `ClinePass · ${index + 1}` : 'ClinePass', createdAt: Date.now(), refreshable: false }, {
      accessToken: key, expiresAt: 0, meta: { planModels: JSON.stringify((config.models ?? []).filter(model => model.startsWith('cline-pass/'))) }
    })
    ids.push(id)
  }
  // The auth store is best effort on disk failures: verify persisted slots before deleting source.
  try {
    const stored = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'auth-accounts.json'), 'utf8')) as { accounts?: { account?: { id?: string }; sealed?: string }[] }
    if (ids.every(id => stored.accounts?.some(row => row.account?.id === id && row.sealed?.startsWith('safe:v1:')))) removeCustomProvider('clinepass')
  } catch { /* Keep the encrypted source if the destination cannot be verified. */ }
}
