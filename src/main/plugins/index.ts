import { app, BrowserWindow, clipboard, shell } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { IpcChannel } from '@shared/ipc'
import type { PluginAccountStatus, PluginAction, PluginStatus, PluginsView, RiskTier } from '@shared/ipc'
import type { Tool } from '../tools/types'
import { ToolError } from '../tools/types'
import { seal, unseal } from '../secrets'
import { HttpTransport, McpClient } from '../mcp/client'
import type { McpToolInfo } from '../mcp/client'
import { browserLogin, githubDeviceLogin, githubIdentity, needsRefresh, refreshTokens } from './oauth'
import type { PluginTokens } from './oauth'

/*
 * Settings → Plugins: hosted MCP servers (GitHub, Supabase, Vercel, …) signed
 * in with OAuth, any number of accounts each. One account per plugin is
 * active; its tools join every session whatever the model, loaded on demand
 * through load_tools like account connectors. Calls go through the approval
 * gate: reads run, writes ask unless Auto is on, destructive tools always ask.
 */

interface Entry { id: string; name: string; url: string; auth: 'oauth' | 'github' }

/** Remote MCP servers checked on 2026-11-11 to publish OAuth metadata (GitHub without registration). */
export const PLUGIN_CATALOG: readonly Entry[] = [
  { id: 'github', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', auth: 'github' },
  { id: 'supabase', name: 'Supabase', url: 'https://mcp.supabase.com/mcp', auth: 'oauth' },
  { id: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com', auth: 'oauth' },
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth' },
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth' },
  { id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth' },
  { id: 'neon', name: 'Neon', url: 'https://mcp.neon.tech/mcp', auth: 'oauth' },
  { id: 'stripe', name: 'Stripe', url: 'https://mcp.stripe.com', auth: 'oauth' },
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://bindings.mcp.cloudflare.com/mcp', auth: 'oauth' },
  { id: 'netlify', name: 'Netlify', url: 'https://netlify-mcp.netlify.app/mcp', auth: 'oauth' },
  { id: 'atlassian', name: 'Atlassian', url: 'https://mcp.atlassian.com/v1/mcp', auth: 'oauth' }
]

interface StoredAccount {
  id: string
  plugin: string
  label: string
  method: PluginAccountStatus['method']
  identity?: string
  /** PluginTokens as JSON, sealed with the OS secure storage. */
  sealed: string
}

interface Stored {
  accounts: StoredAccount[]
  active: Record<string, string>
  disabled: string[]
  custom: Entry[]
  githubClientId: string
}

interface Connection {
  account: string
  client: McpClient | null
  state: PluginStatus['state']
  error: string | null
  tools: McpToolInfo[]
  failedAt: number | null
}

const RETRY_AFTER_MS = 60_000
let stored: Stored | null = null
/** Open tokens; also the only copy when the OS has no secure storage. */
const live = new Map<string, PluginTokens>()
const refreshing = new Map<string, Promise<PluginTokens>>()
const connections = new Map<string, Connection>()
let login: (NonNullable<PluginsView['login']> & { controller: AbortController }) | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'plugins.json')
}

function load(): Stored {
  if (stored !== null) return stored
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Stored>
    stored = {
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      active: parsed.active ?? {},
      disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [],
      custom: Array.isArray(parsed.custom) ? parsed.custom : [],
      githubClientId: typeof parsed.githubClientId === 'string' ? parsed.githubClientId : ''
    }
  } catch {
    stored = { accounts: [], active: {}, disabled: [], custom: [], githubClientId: '' }
  }
  return stored
}

function save(): void {
  mkdirSync(path.dirname(file()), { recursive: true })
  writeFileSync(`${file()}.tmp`, JSON.stringify(load(), null, 2), { mode: 0o600 })
  renameSync(`${file()}.tmp`, file())
}

function entries(): Entry[] {
  return [...PLUGIN_CATALOG, ...load().custom]
}

function entry(id: unknown): Entry {
  const found = entries().find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error('Unknown plugin')
  return found
}

function tokensOf(account: StoredAccount): PluginTokens | null {
  const open = live.get(account.id)
  if (open !== undefined) return open
  try {
    const parsed = JSON.parse(unseal(account.sealed)) as PluginTokens
    if (typeof parsed.accessToken !== 'string') return null
    live.set(account.id, parsed)
    return parsed
  } catch {
    return null
  }
}

function setTokens(account: StoredAccount, tokens: PluginTokens): void {
  live.set(account.id, tokens)
  account.sealed = seal(JSON.stringify(tokens))
  save()
}

/** The active account, or the plugin's first one when the choice is gone. */
function activeAccount(plugin: string): StoredAccount | undefined {
  const accounts = load().accounts.filter((account) => account.plugin === plugin)
  return accounts.find((account) => account.id === load().active[plugin]) ?? accounts[0]
}

/** A token good for the next request, renewed once at a time per account. */
async function freshTokens(account: StoredAccount): Promise<PluginTokens> {
  const tokens = tokensOf(account)
  if (tokens === null) throw new Error('The saved sign-in could not be read; sign in again')
  if (!needsRefresh(tokens)) return tokens
  let pending = refreshing.get(account.id)
  if (pending === undefined) {
    pending = refreshTokens(tokens).then((next) => {
      setTokens(account, next)
      return next
    }).finally(() => refreshing.delete(account.id))
    refreshing.set(account.id, pending)
  }
  return pending
}

function status(item: Entry): PluginStatus {
  const { accounts, disabled } = load()
  const active = activeAccount(item.id)
  const connection = connections.get(item.id)
  const enabled = !disabled.includes(item.id)
  return {
    id: item.id,
    name: item.name,
    url: item.url,
    auth: item.auth,
    custom: !PLUGIN_CATALOG.some((known) => known.id === item.id),
    enabled,
    accounts: accounts.filter((account) => account.plugin === item.id).map(({ id, label, method }) => ({ id, label, method })),
    activeAccount: active?.id ?? null,
    state: !enabled || active === undefined ? 'off' : (connection?.state ?? 'connecting'),
    error: connection?.error ?? null,
    tools: (connection?.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, destructive: tool.annotations?.destructiveHint === true }))
  }
}

export function listPlugins(): PluginsView {
  const current = login === null ? null : { plugin: login.plugin, message: login.message, ...(login.code !== undefined ? { code: login.code } : {}), ...(login.url !== undefined ? { url: login.url } : {}) }
  return { plugins: entries().map(status), githubClientId: load().githubClientId, login: current }
}

function announce(): void {
  const view = listPlugins()
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(IpcChannel.PLUGINS_UPDATED, view)
}

async function disconnect(plugin: string): Promise<void> {
  const connection = connections.get(plugin)
  connections.delete(plugin)
  await connection?.client?.close().catch(() => undefined)
}

/** (Re)connects the plugin's active account, or drops it when off or signed out. */
async function connect(plugin: string): Promise<void> {
  await disconnect(plugin)
  const item = entry(plugin)
  const account = activeAccount(plugin)
  if (account === undefined || load().disabled.includes(plugin)) { announce(); return }
  const connection: Connection = { account: account.id, client: null, state: 'connecting', error: null, tools: [], failedAt: null }
  connections.set(plugin, connection)
  announce()
  const fail = (reason: string): void => {
    connection.state = 'error'
    connection.error = reason
    connection.tools = []
    connection.failedAt = Date.now()
  }
  try {
    const client = new McpClient(new HttpTransport(item.url, async () => ({ authorization: `Bearer ${(await freshTokens(account)).accessToken}` })))
    connection.client = client
    client.onClose = (reason) => {
      if (connections.get(plugin) !== connection) return
      connection.client = null
      fail(reason)
      announce()
    }
    client.onToolsChanged = () => {
      void client.listTools().then((tools) => {
        if (connections.get(plugin) !== connection) return
        connection.tools = tools
        announce()
      }).catch(() => undefined)
    }
    await client.connect(app.getVersion())
    const tools = await client.listTools()
    if (connections.get(plugin) !== connection) return
    connection.tools = tools
    connection.state = 'ready'
  } catch (error) {
    if (connections.get(plugin) !== connection) return
    fail((error as Error).message.replace('. The server wants credentials; add them as a header', '; sign in again'))
    await connection.client?.close().catch(() => undefined)
    connection.client = null
  }
  announce()
}

/** At start-up: the active account of every enabled plugin, in the background. */
export function initPlugins(): void {
  for (const item of entries()) if (activeAccount(item.id) !== undefined && !load().disabled.includes(item.id)) void connect(item.id)
}

async function signIn(item: Entry, token: string | undefined, signal: AbortSignal): Promise<{ tokens: PluginTokens; method: PluginAccountStatus['method'] }> {
  const update = (patch: Partial<NonNullable<PluginsView['login']>>): void => {
    if (login !== null) Object.assign(login, patch)
    announce()
  }
  if (item.auth === 'github' && token !== undefined) {
    update({ message: 'Checking the token with GitHub…' })
    return { tokens: { accessToken: token, expiresAt: 0, identity: await githubIdentity(token) }, method: 'token' }
  }
  if (item.auth === 'github') {
    const clientId = load().githubClientId
    if (clientId === '') throw new Error('Add the client ID of your GitHub OAuth App first, or sign in with a token')
    const tokens = await githubDeviceLogin(clientId, async ({ userCode, verificationUri }) => {
      clipboard.writeText(userCode)
      update({ message: 'Enter this code on GitHub (copied to the clipboard)', code: userCode, url: verificationUri })
      await shell.openExternal(verificationUri)
    }, signal)
    return { tokens, method: 'device' }
  }
  update({ message: `Finding the ${item.name} sign-in…` })
  const tokens = await browserLogin({
    mcpUrl: item.url,
    signal,
    openUrl: async (url) => {
      update({ message: `Finish signing in to ${item.name} in the browser`, url })
      await shell.openExternal(url)
    }
  })
  return { tokens, method: 'oauth' }
}

/** Signs in one more account; the same identity again renews that account instead. */
async function addAccount(plugin: string, token: string | undefined): Promise<void> {
  const item = entry(plugin)
  if (login !== null) throw new Error(`A sign-in to ${entry(login.plugin).name} is still running; finish or cancel it first`)
  const controller = new AbortController()
  login = { plugin, message: 'Starting…', controller }
  announce()
  try {
    const { tokens, method } = await signIn(item, token?.trim() || undefined, controller.signal)
    const accounts = load().accounts
    let account = tokens.identity === undefined ? undefined : accounts.find((candidate) => candidate.plugin === plugin && candidate.identity === tokens.identity)
    if (account === undefined) {
      const count = accounts.filter((candidate) => candidate.plugin === plugin).length
      account = { id: randomUUID(), plugin, label: tokens.identity ?? `${item.name} ${count + 1}`, method, sealed: '', ...(tokens.identity !== undefined ? { identity: tokens.identity } : {}) }
      accounts.push(account)
    } else {
      account.method = method
    }
    load().active[plugin] = account.id
    setTokens(account, tokens)
  } finally {
    login = null
    announce()
  }
  await connect(plugin)
}

function text(value: unknown, what: string, max = 200): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${what} is required`)
  return value.trim().slice(0, max)
}

/** Every change Settings → Plugins can ask for; input is checked here, at the boundary. */
export async function pluginAction(raw: unknown): Promise<PluginsView> {
  const action = (raw ?? {}) as PluginAction
  const data = load()
  switch (action.type) {
    case 'login':
      await addAccount(entry(action.plugin).id, typeof action.token === 'string' ? action.token : undefined)
      break
    case 'cancel-login':
      login?.controller.abort()
      break
    case 'select': {
      const account = data.accounts.find((candidate) => candidate.id === action.account && candidate.plugin === action.plugin)
      if (account === undefined) throw new Error('Unknown account')
      data.active[account.plugin] = account.id
      save()
      await connect(account.plugin)
      break
    }
    case 'enable': {
      const plugin = entry(action.plugin).id
      data.disabled = data.disabled.filter((id) => id !== plugin)
      if (action.enabled !== true) data.disabled.push(plugin)
      save()
      await connect(plugin)
      break
    }
    case 'rename': {
      const account = data.accounts.find((candidate) => candidate.id === action.account)
      if (account === undefined) throw new Error('Unknown account')
      account.label = text(action.label, 'A name', 60)
      save()
      announce()
      break
    }
    case 'remove-account': {
      const account = data.accounts.find((candidate) => candidate.id === action.account)
      if (account === undefined) throw new Error('Unknown account')
      data.accounts = data.accounts.filter((candidate) => candidate.id !== account.id)
      if (data.active[account.plugin] === account.id) delete data.active[account.plugin]
      live.delete(account.id)
      save()
      if (connections.get(account.plugin)?.account === account.id || activeAccount(account.plugin) !== undefined) await connect(account.plugin)
      else announce()
      break
    }
    case 'github-client': {
      const clientId = typeof action.clientId === 'string' ? action.clientId.trim() : ''
      if (clientId !== '' && !/^[A-Za-z0-9._-]{8,64}$/.test(clientId)) throw new Error('That does not look like a GitHub OAuth App client ID')
      data.githubClientId = clientId
      save()
      announce()
      break
    }
    case 'add-custom': {
      const name = text(action.name, 'A name', 40)
      const url = text(action.url, 'The server URL', 500)
      let parsed: URL
      try { parsed = new URL(url) } catch { throw new Error('The server URL is not valid') }
      const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
      if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) throw new Error('The server URL must use https://')
      if (entries().some((item) => item.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already a plugin called “${name}”`)
      data.custom.push({ id: `custom:${randomUUID()}`, name, url: parsed.href, auth: 'oauth' })
      save()
      announce()
      break
    }
    case 'remove-custom': {
      const plugin = data.custom.find((item) => item.id === action.plugin)
      if (plugin === undefined) throw new Error('Unknown plugin')
      await disconnect(plugin.id)
      for (const account of data.accounts) if (account.plugin === plugin.id) live.delete(account.id)
      data.accounts = data.accounts.filter((account) => account.plugin !== plugin.id)
      data.custom = data.custom.filter((item) => item.id !== plugin.id)
      delete data.active[plugin.id]
      save()
      announce()
      break
    }
    case 'reconnect':
      await connect(entry(action.plugin).id)
      break
    default:
      throw new Error('Unknown plugin action')
  }
  return listPlugins()
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool'
}

export function pluginRisk(info: Pick<McpToolInfo, 'annotations'>): RiskTier {
  if (info.annotations?.destructiveHint === true) return 'high'
  return info.annotations?.readOnlyHint === true ? 'low' : 'medium'
}

/** The tools of each plugin's active account, as every session sees them. */
export function pluginTools(): Tool[] {
  const tools: Tool[] = []
  const taken = new Set<string>()
  for (const item of entries()) {
    const connection = connections.get(item.id)
    if (connection?.state === 'error' && connection.failedAt !== null && Date.now() - connection.failedAt > RETRY_AFTER_MS) {
      connection.failedAt = null
      void connect(item.id)
    }
    if (connection?.state !== 'ready') continue
    const account = load().accounts.find((candidate) => candidate.id === connection.account)
    const label = account?.label ?? 'account'
    const connector = `${item.name} plugin`
    for (const info of connection.tools) {
      const base = `plugin__${slug(item.name).slice(0, 20)}__${slug(info.name)}`.slice(0, 64)
      let name = base
      for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 60)}_${n}`
      taken.add(name)
      tools.push({
        name,
        connector,
        description: `${info.description}${info.description === '' ? '' : '\n\n'}(${item.name} plugin, signed in as “${label}”; changes apply to the real service.)`,
        inputSchema: info.inputSchema['type'] === 'object' ? (({ $schema: _ignored, ...rest }) => rest)(info.inputSchema) : { type: 'object', properties: {} },
        readOnly: false,
        prepare: (input) => {
          if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
            throw new ToolError('Invalid input: expected an object of arguments')
          }
          return {
            risk: pluginRisk(info),
            preview: async () => ({
              kind: 'text' as const,
              subject: `${item.name} · ${info.name}`,
              detail: `Plugin: ${item.name} (${label})\nTool: ${info.name}\n\n${JSON.stringify(input ?? {}, null, 2)}`
            }),
            execute: async (context) => {
              const current = connections.get(item.id)
              if (current?.client === null || current?.client === undefined || current.account !== connection.account) {
                throw new ToolError(`The ${item.name} plugin is not connected with “${label}” any more; load its tools again`)
              }
              const result = await current.client.callTool(info.name, input ?? {}, context.signal)
              return { text: result.text === '' ? '(no output)' : result.text, images: result.images, isError: result.isError }
            }
          }
        }
      })
    }
  }
  return tools
}

/** Plugin tokens, for masking in exports. */
export function pluginSecrets(): string[] {
  return load().accounts.flatMap((account) => {
    const tokens = tokensOf(account)
    return tokens === null ? [] : [tokens.accessToken, tokens.refreshToken ?? '', tokens.clientSecret ?? ''].filter((value) => value !== '')
  })
}

export async function closePlugins(): Promise<void> {
  login?.controller.abort()
  await Promise.all([...connections.keys()].map((id) => disconnect(id)))
}
