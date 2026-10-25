import { loginClinePass, clinePassIdentity } from './clinepass'
import { isTransient } from '../providers/failures'
import { loginOpenCodeGo } from './opencodeGo'
import { loginOpenRouter } from './openrouter'
import { loginKilo } from './kilo'
import { loginCopilot } from './copilot'
import { loginCursor } from './cursor'
import { loginAntigravity } from './antigravity'
import { loginVercel } from './vercel'
import { loginMiniMaxPlan } from './minimaxPlan'
import { randomUUID } from 'node:crypto'
import {
  listAuthAccounts,
  getAuthAccount,
  readAuthTokens,
  saveAuthAccount,
  updateAuthTokens,
  removeAuthAccount as deleteAuthAccount,
  renameAuthAccount,
  authAccountExists
} from './store'
import { loginCodex, accountLabel as codexLabel } from './codex'
import { loginClaude, accountLabel as claudeLabel } from './claude'
import { loginCline, accountLabel as clineLabel } from './cline'
import { loginCodebuddy, accountLabel as codebuddyLabel } from './codebuddy'
import { forgetAuthCatalogue } from './catalogue'
import { ensureFreshAuthTokens } from './provider'
import { withRelogin } from './types'
import type { AuthAccount, AuthKind, AuthLoginCallbacks, AuthTokens } from './types'

export { listAuthAccounts, getAuthAccount, readAuthTokens, renameAuthAccount }

export function removeAuthAccount(id: string): void {
  deleteAuthAccount(id)
  forgetAuthCatalogue(id)
}

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
  return id.startsWith(AUTH_PREFIX) || (id === 'clinepass' && getAuthAccount(id)?.kind === 'clinepass')
}

export const AUTH_KIND_LABELS: Record<AuthKind, string> = {
  'minimax-plan': 'MiniMax Token Plan',
  kilo: 'Kilo Free',
  vercel: 'Vercel AI Gateway',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  openrouter: 'OpenRouter Free',
  codex: 'ChatGPT (Codex)',
  claude: 'Claude Code',
  cline: 'Cline Free',
  clinepass: 'ClinePass',
  'opencode-go': 'OpenCode Go',
  codebuddy: 'CodeBuddy'
}

function runLogin(kind: AuthKind, callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  switch (kind) {
    case 'clinepass': return loginClinePass(callbacks)
    case 'minimax-plan': return loginMiniMaxPlan(callbacks)
    case 'kilo': return loginKilo(callbacks)
    case 'openrouter': return loginOpenRouter(callbacks)
    case 'codex':
      return loginCodex(callbacks)
    case 'claude':
      return loginClaude(callbacks)
    case 'cline':
      return loginCline(callbacks)
    case 'opencode-go': return loginOpenCodeGo(callbacks)
    case 'codebuddy':
      return loginCodebuddy(callbacks)
    case 'vercel':
      return loginVercel(callbacks)
    case 'copilot': return loginCopilot(callbacks)
    case 'cursor': return loginCursor(callbacks)
    case 'antigravity': return loginAntigravity(callbacks)
  }
}

function labelFor(kind: AuthKind, tokens: AuthTokens): string | undefined {
  switch (kind) {
    case 'cursor':
    case 'copilot':
    case 'antigravity': return tokens.meta?.account
    case 'minimax-plan': return undefined
    case 'kilo': return tokens.meta?.email || undefined
    case 'openrouter': return undefined
    case 'vercel': return undefined
    case 'opencode-go': return undefined
    case 'codex':
      return codexLabel(tokens)
    case 'claude':
      return claudeLabel(tokens)
    case 'codebuddy':
      return codebuddyLabel(tokens)
    case 'clinepass':
    case 'cline':
      return clineLabel(tokens)
  }
}

/** Stable provider identity prevents browser SSO from creating duplicate quota slots. */
function sameAccount(existing: AuthAccount, tokens: AuthTokens, label: string | undefined): boolean {
  const previous = readAuthTokens(existing.id)
  const oldId = (previous?.meta?.accountId || previous?.meta?.userId)?.trim()
  const newId = (tokens.meta?.accountId || tokens.meta?.userId)?.trim()
  if (oldId && newId) return oldId === newId
  const oldLabel = (existing.account ?? previous?.meta?.email ?? '').trim().toLowerCase()
  const newLabel = (label ?? tokens.meta?.email ?? '').trim().toLowerCase()
  return oldLabel && newLabel ? oldLabel === newLabel : previous?.accessToken === tokens.accessToken
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
  if (kind === 'clinepass' && tokens.meta?.accountId) {
    // Link an imported plan key to the same browser subscription before creating a new slot.
    for (const row of listAuthAccounts().filter(row => row.kind === 'clinepass')) {
      const previous = readAuthTokens(row.id)
      if (!previous || previous.meta?.accountId) continue
      try {
        const accountId = await clinePassIdentity(previous, callbacks.signal)
        if (accountId) updateAuthTokens(row.id, { ...previous, meta: { ...previous.meta, accountId } })
      } catch { callbacks.signal.throwIfAborted() }
    }
  }
  const vendorLabel = AUTH_KIND_LABELS[kind]
  const account = labelFor(kind, tokens)
  const existing = listAuthAccounts().find((row) => row.kind === kind && sameAccount(row, tokens, account))
  if (existing) {
    const updated: AuthAccount = {
      ...existing,
      ...(account ? { account } : {}),
      ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : { expiresAt: 0 }),
      refreshable: tokens.refreshToken !== undefined
    }
    saveAuthAccount(updated, { ...tokens, meta: { ...readAuthTokens(existing.id)?.meta, ...tokens.meta } })
    forgetAuthCatalogue(updated.id)
    return updated
  }

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
  forgetAuthCatalogue(id)
  return record
}

/** True when the vendor has a refresh grant we can call for this account. */
export function canRefreshAuthAccount(kind: AuthKind): boolean {
  return !['cursor', 'copilot', 'opencode-go', 'kilo', 'openrouter', 'vercel', 'minimax-plan'].includes(kind)
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
      `${AUTH_KIND_LABELS[account.kind]} issues a long-lived token and has no renewal. ` +
        'Sign in again when it stops working.'
    )
  }
  const tokens = readAuthTokens(id)
  if (tokens === null) {
    throw new Error('The stored token could not be unsealed. Sign in again to replace it.')
  }
  if (tokens.refreshToken === undefined) {
    throw new Error('This login came without a refresh token. Sign in again to replace it.')
  }
  try {
    await ensureFreshAuthTokens(id, true)
  } catch (error) {
    if (isTransient(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(withRelogin(message.replace(/\.*$/, '.')))
  }
}

export function newRequestId(): string {
  return randomUUID().replace(/-/g, '')
}

export type { AuthKind, AuthAccount, AuthTokens, AuthLoginCallbacks }
