import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import type { RiskTier } from '@shared/ipc'
import type { Tool } from '../tools/types'
import { ToolError } from '../tools/types'
import { getAuthAccount, listAuthAccounts } from '../auth/store'
import { ensureFreshAuthTokens } from '../auth/provider'
import { CODEX_CLIENT_VERSION } from '../providers/codexConfig'
import { HttpTransport, McpClient } from './client'
import type { McpToolInfo } from './client'
import { mcpToolName } from './manager'

/*
 * Hosted connectors of the account a session runs on, the way each vendor's
 * own app reaches them. The connector grants (Google, GitHub, …) stay with
 * the vendor; Anticode only presents the account's own token.
 *
 * - ChatGPT (Codex): the "codex_apps" MCP server at chatgpt.com/backend-api/ps/mcp,
 *   one server for every app connected in ChatGPT → Apps.
 * - Claude: GET api.anthropic.com/v1/mcp_servers lists the connectors added in
 *   claude.ai; each is reached through mcp-proxy.anthropic.com/v1/mcp/{id}.
 *
 * Accounts of other kinds (Cline, Kilo, CodeBuddy, OpenRouter, …) have no
 * hosted connectors. See docs/research/codex-google-drive-2026-10-25.md.
 */

export const CHATGPT_APPS_URL = 'https://chatgpt.com/backend-api/ps/mcp'
export const CLAUDE_CONNECTORS_URL = 'https://api.anthropic.com/v1/mcp_servers?limit=1000'
export const CLAUDE_PROXY_URL = 'https://mcp-proxy.anthropic.com/v1/mcp/'
const CLAUDE_BETA = 'oauth-2025-04-20,mcp-servers-2025-12-04'
const RETRY_AFTER_MS = 60_000

/** ChatGPT's own plumbing, offered to Codex itself but not apps a user connected. */
const CHATGPT_INTERNAL = new Set(['plugin management', 'safety settings', 'codex document control', 'pets', 'hotline', 'search service'])

export type ConnectorKind = 'codex' | 'claude'

export function connectorKind(kind: string | undefined): ConnectorKind | null {
  return kind === 'codex' || kind === 'claude' ? kind : null
}

/** The connector a ChatGPT apps tool belongs to, or null for ChatGPT internals. */
export function chatgptConnectorOf(info: Pick<McpToolInfo, 'name' | 'meta'>): string | null {
  const named = info.meta?.['connector_name']
  const name = typeof named === 'string' && named.trim() !== ''
    ? named.trim()
    : info.name.includes('.') ? info.name.split('.')[0]!.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null
  if (name === null || CHATGPT_INTERNAL.has(name.toLowerCase())) return null
  return name
}

/** Reads run freely; writes ask unless Auto is on; destructive ones always ask. */
export function connectorRisk(info: Pick<McpToolInfo, 'annotations'>): RiskTier {
  if (info.annotations?.destructiveHint === true) return 'high'
  if (info.annotations?.readOnlyHint === true) return 'low'
  return 'medium'
}

interface Offered {
  connector: string
  info: McpToolInfo
  client: McpClient
}

interface AccountState {
  kind: ConnectorKind
  clients: McpClient[]
  tools: Offered[]
  connecting: boolean
  failedAt: number | null
  error: string | null
}

const accounts = new Map<string, AccountState>()

async function codexHeaders(account: string): Promise<Record<string, string>> {
  const tokens = await ensureFreshAuthTokens(account)
  // The same identity Anticode's ChatGPT (Codex) provider already uses.
  return {
    authorization: `Bearer ${tokens.accessToken}`,
    originator: 'codex_cli_rs',
    'user-agent': `codex_cli_rs/${CODEX_CLIENT_VERSION}`,
    ...(tokens.meta?.accountId ? { 'chatgpt-account-id': tokens.meta.accountId } : {})
  }
}

async function claudeHeaders(account: string): Promise<Record<string, string>> {
  const tokens = await ensureFreshAuthTokens(account)
  return {
    authorization: `Bearer ${tokens.accessToken}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': CLAUDE_BETA,
    'user-agent': `anticode/${app.getVersion()}`
  }
}

async function open(id: string, url: string, headers: () => Promise<Record<string, string>>, state: AccountState): Promise<McpClient> {
  const client = new McpClient(new HttpTransport(url, headers))
  state.clients.push(client)
  client.onClose = (reason) => {
    if (accounts.get(id) !== state) return
    state.tools = state.tools.filter((tool) => tool.client !== client)
    state.failedAt = Date.now()
    state.error = reason
  }
  await client.connect(app.getVersion())
  return client
}

interface ClaudeServer { id?: unknown; display_name?: unknown; eligible?: unknown }

async function connectClaude(id: string, state: AccountState): Promise<void> {
  const response = await fetch(CLAUDE_CONNECTORS_URL, { headers: await claudeHeaders(id), signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`claude.ai connectors: HTTP ${response.status}`)
  const listed = ((await response.json()) as { data?: ClaudeServer[] }).data ?? []
  const servers = listed.filter((server): server is { id: string; display_name: string } =>
    typeof server.id === 'string' && typeof server.display_name === 'string' && server.eligible !== false)
  // One connector failing to start does not hide the others.
  await Promise.all(servers.map(async (server) => {
    try {
      // The proxy requires a client session id per connection, as Claude Code sends.
      const session = randomUUID()
      const headers = async (): Promise<Record<string, string>> => ({ ...(await claudeHeaders(id)), 'x-mcp-client-session-id': session })
      const client = await open(id, `${CLAUDE_PROXY_URL}${encodeURIComponent(server.id)}`, headers, state)
      const tools = await client.listTools()
      if (accounts.get(id) !== state) return
      state.tools.push(...tools.map((info) => ({ connector: server.display_name, info, client })))
    } catch (error) {
      state.error = `${server.display_name}: ${(error as Error).message}`
    }
  }))
}

async function connectCodex(id: string, state: AccountState): Promise<void> {
  const client = await open(id, CHATGPT_APPS_URL, () => codexHeaders(id), state)
  const tools = await client.listTools()
  if (accounts.get(id) !== state) return
  state.tools = tools.flatMap((info) => {
    const connector = chatgptConnectorOf(info)
    return connector === null ? [] : [{ connector, info, client }]
  })
}

async function connect(id: string, kind: ConnectorKind): Promise<void> {
  const previous = accounts.get(id)
  const state: AccountState = { kind, clients: [], tools: [], connecting: true, failedAt: null, error: null }
  accounts.set(id, state)
  await Promise.all((previous?.clients ?? []).map((client) => client.close().catch(() => undefined)))
  try {
    await (kind === 'codex' ? connectCodex(id, state) : connectClaude(id, state))
  } catch (error) {
    if (accounts.get(id) !== state) return
    state.failedAt = Date.now()
    state.error = (error as Error).message
  } finally {
    state.connecting = false
  }
}

/**
 * Starts the account's connectors when nothing is connected yet. Cheap to
 * call often: it never blocks and waits a minute after a failure.
 */
export function ensureAccountConnectors(id: string): void {
  const kind = connectorKind(getAuthAccount(id)?.kind)
  if (kind === null) {
    if (accounts.has(id)) forgetAccountConnectors(id)
    return
  }
  const state = accounts.get(id)
  if (state !== undefined) {
    if (state.connecting || state.failedAt === null) return
    if (Date.now() - state.failedAt < RETRY_AFTER_MS) return
  }
  void connect(id, kind)
}

/** At start-up: connectors of every ChatGPT and Claude account, in the background. */
export function initAccountConnectors(): void {
  for (const stored of listAuthAccounts()) if (connectorKind(stored.kind) !== null) ensureAccountConnectors(stored.id)
}

/** A short account label for telling apart the same connector on two accounts. */
function accountLabel(id: string): string {
  return id.replace(/^auth:/, '')
}

function asTool(id: string, offered: Offered, name: string, connector: string): Tool {
  const { info } = offered
  const vendor = accounts.get(id)?.kind === 'claude' ? 'claude.ai' : 'ChatGPT'
  return {
    name,
    connector,
    description: `${info.description}${info.description === '' ? '' : '\n\n'}(${connector} connector of the signed-in ${vendor} account; changes apply to the real service.)`,
    inputSchema: info.inputSchema['type'] === 'object' ? info.inputSchema : { type: 'object', properties: {} },
    readOnly: false,
    prepare: (raw) => {
      if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
        throw new ToolError('Invalid input: expected an object of arguments')
      }
      return {
        risk: connectorRisk(info),
        preview: async () => ({
          kind: 'text' as const,
          subject: `${connector} · ${info.name}`,
          detail: `${connector} (${vendor} connector)\nTool: ${info.name}\n\n${JSON.stringify(raw ?? {}, null, 2)}`
        }),
        execute: async (context) => {
          if (!(accounts.get(id)?.tools.includes(offered) ?? false)) {
            throw new ToolError(`${connector} is not connected right now. Check that it is still connected in ${vendor} and try again.`)
          }
          const result = await offered.client.callTool(info.name, raw ?? {}, context.signal)
          return { text: result.text === '' ? '(no output)' : result.text, images: result.images, isError: result.isError }
        }
      }
    }
  }
}

/**
 * The connectors of every stored ChatGPT and Claude account, shared by every
 * session whatever model it runs on (Cline, Kilo, OpenRouter, …). Accounts go
 * in stored order so names stay stable across Rotate usage and reopened
 * sessions: the first account with a connector keeps its plain name ("Google
 * Drive"); the same connector on a later account is "Google Drive (claude-2)".
 */
export function accountConnectorTools(_providerId?: string): Tool[] {
  const ids = listAuthAccounts().filter((stored) => connectorKind(stored.kind) !== null).map((stored) => stored.id)
  const claimed = new Set<string>()
  const taken = new Set<string>()
  const out: Tool[] = []
  for (const id of ids) {
    ensureAccountConnectors(id)
    const state = accounts.get(id)
    if (state === undefined) continue
    const keys = new Map<string, { key: string; prefix: string }>()
    for (const offered of state.tools) {
      let named = keys.get(offered.connector)
      if (named === undefined) {
        const duplicate = claimed.has(offered.connector.toLowerCase())
        named = duplicate
          // Tool-name prefixes keep 20 characters: the account goes first so it survives.
          ? { key: `${offered.connector} (${accountLabel(id)})`, prefix: `${accountLabel(id)} ${offered.connector}` }
          : { key: offered.connector, prefix: offered.connector }
        keys.set(offered.connector, named)
        claimed.add(named.key.toLowerCase())
      }
      const key = named.key
      const base = mcpToolName(named.prefix, offered.info.name)
      let name = base
      for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 60)}_${n}`
      taken.add(name)
      out.push(asTool(id, offered, name, key))
    }
  }
  return out
}

export interface AccountConnectorStatus {
  connecting: boolean
  error: string | null
  /** Connector name → number of tools offered. */
  connectors: Record<string, number>
}

/** What an account's connectors look like right now; null when never started. */
export function accountConnectorStatus(id: string): AccountConnectorStatus | null {
  const state = accounts.get(id)
  if (state === undefined) return null
  const connectors: Record<string, number> = {}
  for (const tool of state.tools) connectors[tool.connector] = (connectors[tool.connector] ?? 0) + 1
  return { connecting: state.connecting, error: state.error, connectors }
}

/** Lets go of accounts that were removed or signed out. */
export function forgetAccountConnectors(id: string): void {
  const state = accounts.get(id)
  accounts.delete(id)
  for (const client of state?.clients ?? []) void client.close().catch(() => undefined)
}

export async function closeAccountConnectors(): Promise<void> {
  const all = [...accounts.values()]
  accounts.clear()
  await Promise.all(all.flatMap((state) => state.clients.map((client) => client.close().catch(() => undefined))))
}
