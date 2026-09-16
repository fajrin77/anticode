import { randomUUID } from 'node:crypto'
import {
  listAuthAccounts,
  getAuthAccount,
  readAuthTokens,
  saveAuthAccount,
  updateAuthTokens,
  removeAuthAccount,
  renameAuthAccount,
  authAccountExists
} from './store'
import { loginCodex, refreshCodex, accountLabel as codexLabel } from './codex'
import { loginClaude, refreshClaude, accountLabel as claudeLabel } from './claude'
import { loginCline, refreshCline } from './cline'
import { loginCodebuddy, accountLabel as codebuddyLabel } from './codebuddy'
import type { AuthAccount, AuthKind, AuthLoginCallbacks, AuthTokens } from './types'

export { listAuthAccounts, getAuthAccount, readAuthTokens, removeAuthAccount, renameAuthAccount }

/**
 * What Settings lists. `usable` is the one fact the renderer cannot work out
 * for itself: the tokens are sealed, and an account whose seal will not open
 * (locked keychain, a file copied from another machine) looks perfectly fine
 * in the plaintext half while being unable to answer a single turn.
 */
export function listAuthAccountSummaries(): (AuthAccount & { usable: boolean })[] {
  return listAuthAccounts().map((account) => ({
    ...account,
    usable: readAuthTokens(account.id) !== null
  }))
}

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

/** True when the vendor has a refresh grant we can call for this account. */
export function canRefreshAuthAccount(kind: AuthKind): boolean {
  return kind !== 'codebuddy'
}

/**
 * Renews one account's tokens in place. Settings calls this straight from the
 * Renew button, so every way it can fail has to say something a person can
 * act on rather than throw a bare vendor status.
 */
export async function refreshAuthAccount(id: string): Promise<void> {
  const account = getAuthAccount(id)
  if (account === undefined) throw new Error('That account is no longer stored.')
  if (!canRefreshAuthAccount(account.kind)) {
    throw new Error(
      `${AUTH_KIND_LABELS[account.kind]} issues a long-lived token and has no renewal — ` +
        'sign in again when it stops working.'
    )
  }
  const tokens = readAuthTokens(id)
  if (tokens === null) {
    throw new Error('The stored token could not be unsealed. Sign in again to replace it.')
  }
  if (tokens.refreshToken === undefined) {
    throw new Error('This login came without a refresh token. Sign in again to replace it.')
  }
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
      return
  }
  updateAuthTokens(id, next)
}

export function newRequestId(): string {
  return randomUUID().replace(/-/g, '')
}

export type { AuthKind, AuthAccount, AuthTokens, AuthLoginCallbacks }