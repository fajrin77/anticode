import { randomUUID } from 'node:crypto'
import {
  listAuthAccounts,
  getAuthAccount,
  readAuthTokens,
  saveAuthAccount,
  updateAuthTokens,
  removeAuthAccount,
  authAccountExists
} from './store'
import { loginCodex, refreshCodex, accountLabel as codexLabel } from './codex'
import { loginClaude, refreshClaude, accountLabel as claudeLabel } from './claude'
import { loginCline, refreshCline } from './cline'
import { loginCodebuddy, accountLabel as codebuddyLabel } from './codebuddy'
import type { AuthAccount, AuthKind, AuthLoginCallbacks, AuthTokens } from './types'

export { listAuthAccounts, getAuthAccount, readAuthTokens, removeAuthAccount }

export const AUTH_PREFIX = 'auth:'

/** The provider id an account shows up as, e.g. `auth:codex`. */
export function authProviderId(kind: AuthKind, label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `${AUTH_PREFIX}${kind}${slug === '' || slug === kind ? '' : `-${slug}`}`
}

export function isAuthProvider(id: string): boolean {
  return id.startsWith(AUTH_PREFIX)
}

export const AUTH_KIND_LABELS: Record<AuthKind, string> = {
  codex: 'ChatGPT (Codex)',
  claude: 'Claude Code',
  cline: 'Cline',
  codebuddy: 'CodeBuddy'
}

function runLogin(kind: AuthKind, callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  switch (kind) {
    case 'codex':
      return loginCodex(callbacks)
    case 'claude':
      return loginClaude(callbacks)
    case 'cline':
      return loginCline(callbacks)
    case 'codebuddy':
      return loginCodebuddy(callbacks)
  }
}

function labelFor(kind: AuthKind, tokens: AuthTokens): string | undefined {
  switch (kind) {
    case 'codex':
      return codexLabel(tokens)
    case 'claude':
      return claudeLabel(tokens)
    case 'codebuddy':
      return codebuddyLabel(tokens)
    case 'cline':
      return undefined
  }
}

/**
 * Runs the vendor's login flow and stores the account. A second account of
 * the same kind gets a numbered id, so two ChatGPT logins can coexist and be
 * rotated between.
 */
export async function loginAuthAccount(
  kind: AuthKind,
  callbacks: AuthLoginCallbacks
): Promise<AuthAccount> {
  const tokens = await runLogin(kind, callbacks)
  const vendorLabel = AUTH_KIND_LABELS[kind]
  const account = labelFor(kind, tokens)

  let id = authProviderId(kind, '')
  let suffix = 2
  while (authAccountExists(id)) {
    id = `${authProviderId(kind, '')}-${suffix}`
    suffix += 1
  }

  const record: AuthAccount = {
    id,
    kind,
    label: account !== undefined && account !== '' ? `${vendorLabel} · ${account}` : vendorLabel,
    ...(account !== undefined && account !== '' ? { account } : {}),
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    createdAt: Date.now(),
    refreshable: tokens.refreshToken !== undefined
  }
  saveAuthAccount(record, tokens)
  return record
}

/** Refreshes one account's tokens in place, when the vendor supports it. */
export async function refreshAuthAccount(id: string): Promise<void> {
  const tokens = readAuthTokens(id)
  const account = getAuthAccount(id)
  if (tokens === null || account === undefined) throw new Error('Account not found')
  let next: AuthTokens
  switch (account.kind) {
    case 'codex':
      next = await refreshCodex(tokens)
      break
    case 'claude':
      next = await refreshClaude(tokens)
      break
    case 'cline':
      next = await refreshCline(tokens)
      break
    case 'codebuddy':
      return // Poll-based login; the token lasts long enough to not refresh.
  }
  updateAuthTokens(id, next)
}

export function newRequestId(): string {
  return randomUUID().replace(/-/g, '')
}

export type { AuthKind, AuthAccount, AuthTokens, AuthLoginCallbacks }