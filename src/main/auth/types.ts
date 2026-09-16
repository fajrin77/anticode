/*
 * Auth provider accounts — OAuth logins that back a chat provider, the way
 * the Codex/Claude/Cline/CodeBuddy CLIs do it. One account holds the tokens;
 * a provider id like `auth:codex` reads them and talks to the vendor API.
 *
 * Tokens are sealed with the OS keychain through src/main/secrets.ts before
 * they touch disk, exactly like API keys, so nothing plaintext is written.
 */

/** Which vendor flow an account was created by. */
export type AuthKind = 'codex' | 'claude' | 'cline' | 'codebuddy'

/** Live state of an account as the Settings UI needs it. */
export interface AuthAccount {
  /** Stable id, e.g. `auth/codex` — what rotation entries point at. */
  id: string
  kind: AuthKind
  /** Free-form label the user sees; defaults to the vendor name. */
  label: string
  /** Email or account name, when the vendor returned one. */
  account?: string
  /** Epoch ms the access token stops being valid, when known. */
  expiresAt?: number
  /** Epoch ms the account was added. */
  createdAt: number
  /** True when a refresh token is on file. */
  refreshable: boolean
}

/** The secrets we keep, sealed at rest. */
export interface AuthTokens {
  accessToken: string
  refreshToken?: string
  /** Epoch ms the access token expires; 0 when the vendor does not say. */
  expiresAt?: number
  /** Extra vendor-specific fields (id token, session state, account id). */
  meta?: Record<string, string>
}

/** One account's stored form: the public record plus its sealed tokens. */
export interface StoredAuthAccount {
  account: AuthAccount
  tokens: AuthTokens
}

/** What a login flow reports back while it runs. */
export interface AuthLoginUpdate {
  /** Human status, e.g. "Waiting for you to approve in the browser". */
  message: string
  /** The URL the user must open, when the flow needs one. */
  url?: string
  /** A code the user must paste back, when the flow needs one. */
  needsCode?: boolean
  /** Set when the flow is finished. */
  done?: boolean
}

/** The prompt-code callback a paste-code flow (Claude) uses. */
export type PromptForCode = (message: string) => Promise<string>

/** Everything a login flow can report through. */
export interface AuthLoginCallbacks {
  onUpdate: (update: AuthLoginUpdate) => void
  /** Only paste-code flows call this. */
  promptForCode: PromptForCode
}