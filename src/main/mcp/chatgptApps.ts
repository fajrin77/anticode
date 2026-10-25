import { app } from 'electron'
import type { RiskTier } from '@shared/ipc'
import type { Tool } from '../tools/types'
import { ToolError } from '../tools/types'
import { listAuthAccounts } from '../auth/store'
import { ensureFreshAuthTokens } from '../auth/provider'
import { CODEX_CLIENT_VERSION } from '../providers/codexConfig'
import { HttpTransport, McpClient } from './client'
import type { McpToolInfo } from './client'
import { mcpToolName } from './manager'

/*
 * Google Drive the way the ChatGPT/Codex desktop app reaches it: through the
 * ChatGPT connector runtime, an MCP server ("codex_apps") at
 * chatgpt.com/backend-api/ps/mcp, authorised by the signed-in ChatGPT
 * account. The Drive OAuth grant lives on the ChatGPT side (connected in
 * ChatGPT → Apps); Anticode never sees a Google token. Only the Google Drive
 * connector's tools are offered, not the whole catalogue of several hundred.
 * See docs/research/codex-google-drive-2026-10-25.md.
 */

export const CHATGPT_APPS_URL = 'https://chatgpt.com/backend-api/ps/mcp'
export const DRIVE_SERVER_NAME = 'Google Drive'
const DRIVE_PREFIX = 'google_drive.'
const RETRY_AFTER_MS = 60_000

/** The connector tools Anticode offers: Google Drive (Docs, Sheets, Slides) only. */
export function driveTools(tools: McpToolInfo[]): McpToolInfo[] {
  return tools.filter((tool) => tool.name.startsWith(DRIVE_PREFIX))
}

/** Reads run freely; writes ask unless Auto is on; destructive ones always ask. */
export function driveRisk(info: Pick<McpToolInfo, 'annotations'>): RiskTier {
  if (info.annotations?.destructiveHint === true) return 'high'
  if (info.annotations?.readOnlyHint === true) return 'low'
  return 'medium'
}

/** The ChatGPT (Codex) account the connector runs under: the first one stored. */
export function connectorAccount(accounts: { id: string; kind: string }[]): string | null {
  return accounts.find((account) => account.kind === 'codex')?.id ?? null
}

interface State {
  account: string
  client: McpClient | null
  tools: McpToolInfo[]
  connecting: boolean
  failedAt: number | null
  error: string | null
}

let state: State | null = null

async function headersFor(account: string): Promise<Record<string, string>> {
  const tokens = await ensureFreshAuthTokens(account)
  // The same identity Anticode's ChatGPT (Codex) provider already uses.
  return {
    authorization: `Bearer ${tokens.accessToken}`,
    originator: 'codex_cli_rs',
    'user-agent': `codex_cli_rs/${CODEX_CLIENT_VERSION}`,
    ...(tokens.meta?.accountId ? { 'chatgpt-account-id': tokens.meta.accountId } : {})
  }
}

async function connect(account: string): Promise<void> {
  const current: State = { account, client: null, tools: [], connecting: true, failedAt: null, error: null }
  state = current
  try {
    const client = new McpClient(new HttpTransport(CHATGPT_APPS_URL, () => headersFor(account)))
    current.client = client
    client.onClose = (reason) => {
      if (state !== current) return
      current.client = null
      current.tools = []
      current.failedAt = Date.now()
      current.error = reason
    }
    await client.connect(app.getVersion())
    const tools = driveTools(await client.listTools())
    if (state !== current) return
    current.tools = tools
  } catch (error) {
    if (state !== current) return
    await current.client?.close().catch(() => undefined)
    current.client = null
    current.failedAt = Date.now()
    current.error = (error as Error).message
  } finally {
    current.connecting = false
  }
}

/**
 * Starts (or restarts) the connection when a ChatGPT account is stored and
 * nothing is connected yet. Cheap to call often: it never blocks and waits a
 * minute after a failure before trying again.
 */
export function ensureChatgptApps(): void {
  const account = connectorAccount(listAuthAccounts())
  if (account === null) {
    if (state !== null) void closeChatgptApps()
    return
  }
  if (state !== null && state.account === account) {
    if (state.connecting || state.client !== null) return
    if (state.failedAt !== null && Date.now() - state.failedAt < RETRY_AFTER_MS) return
  }
  void connect(account)
}

export function chatgptAppsTools(): Tool[] {
  ensureChatgptApps()
  const current = state
  if (current === null || current.client === null) return []
  return current.tools.map((info) => ({
    name: mcpToolName(DRIVE_SERVER_NAME, info.name),
    description: `${info.description}${info.description === '' ? '' : '\n\n'}(Google Drive connector of the signed-in ChatGPT account; edits apply to the real file in Drive.)`,
    inputSchema: info.inputSchema['type'] === 'object' ? info.inputSchema : { type: 'object', properties: {} },
    readOnly: false,
    prepare: (raw) => {
      if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
        throw new ToolError('Invalid input: expected an object of arguments')
      }
      return {
        risk: driveRisk(info),
        preview: async () => ({
          kind: 'text' as const,
          subject: `${DRIVE_SERVER_NAME} · ${info.name}`,
          detail: `Google Drive (ChatGPT connector)\nTool: ${info.name}\n\n${JSON.stringify(raw ?? {}, null, 2)}`
        }),
        execute: async (context) => {
          const client = state?.client
          if (client === null || client === undefined) {
            throw new ToolError('Google Drive is not connected. Sign in to ChatGPT in Settings and connect Google Drive in ChatGPT → Apps.')
          }
          const result = await client.callTool(info.name, raw ?? {}, context.signal)
          return { text: result.text === '' ? '(no output)' : result.text, images: result.images, isError: result.isError }
        }
      }
    }
  }))
}

export async function closeChatgptApps(): Promise<void> {
  const current = state
  state = null
  await current?.client?.close().catch(() => undefined)
}
