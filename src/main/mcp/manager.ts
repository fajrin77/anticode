import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { IpcChannel } from '@shared/ipc'
import type { McpServerInput, McpServerStatus, RiskTier } from '@shared/ipc'
import type { Tool } from '../tools/types'
import { ToolError } from '../tools/types'
import { seal, unseal } from '../secrets'
import { shellPath } from '../shellPath'
import { HttpTransport, McpClient, StdioTransport } from './client'
import type { McpToolInfo } from './client'

/*
 * The MCP servers set up in Settings → MCP: kept in mcp.json (their tokens
 * sealed like API keys), started when enabled, and their tools offered to
 * anticode sessions as `mcp__<server>__<tool>`. Every call goes through the
 * same approval gate as the built-in tools: asked each time by default, asked
 * every time for a tool the server calls destructive, and never for a server
 * the user chose to trust.
 */

interface StoredServer {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  /** Values sealed on disk, open in memory. */
  env: Record<string, string>
  url: string
  headers: Record<string, string>
  trust: boolean
}

interface Connection {
  client: McpClient | null
  state: McpServerStatus['state']
  error: string | null
  tools: McpToolInfo[]
}

let servers: StoredServer[] | null = null
const connections = new Map<string, Connection>()

function file(): string {
  return path.join(app.getPath('userData'), 'mcp.json')
}

function sealAll(record: Record<string, string>, transform: (value: string) => string): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, transform(value)]))
}

function load(): StoredServer[] {
  if (servers !== null) return servers
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as { servers?: StoredServer[] }
    servers = (parsed.servers ?? []).map((server) => ({
      ...server,
      env: sealAll(server.env ?? {}, unseal),
      headers: sealAll(server.headers ?? {}, unseal)
    }))
  } catch {
    servers = []
  }
  return servers
}

function save(next: StoredServer[]): void {
  servers = next
  mkdirSync(path.dirname(file()), { recursive: true })
  const onDisk = next.map((server) => ({ ...server, env: sealAll(server.env, seal), headers: sealAll(server.headers, seal) }))
  writeFileSync(`${file()}.tmp`, JSON.stringify({ servers: onDisk }, null, 2), { mode: 0o600 })
  renameSync(`${file()}.tmp`, file())
}

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool'
}

/** Provider tool names are at most 64 of [A-Za-z0-9_-]. */
export function mcpToolName(server: string, tool: string): string {
  const prefix = `mcp__${slug(server).slice(0, 20)}__`
  return `${prefix}${slug(tool)}`.slice(0, 64)
}

/**
 * Providers want an object schema without `$schema`; a server that sends
 * anything else gets an empty object schema rather than a failed request.
 */
function toolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema
  return rest['type'] === 'object' ? rest : { type: 'object', properties: {} }
}

export function mcpRisk(trusted: boolean, info: Pick<McpToolInfo, 'annotations'>): RiskTier {
  if (trusted) return 'low'
  return info.annotations?.destructiveHint === true ? 'high' : 'medium'
}

function status(server: StoredServer): McpServerStatus {
  const connection = connections.get(server.id)
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    trust: server.trust,
    envKeys: Object.keys(server.env),
    headerKeys: Object.keys(server.headers),
    state: !server.enabled ? 'off' : (connection?.state ?? 'connecting'),
    error: connection?.error ?? null,
    tools: (connection?.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      destructive: tool.annotations?.destructiveHint === true
    }))
  }
}

export function listMcp(): McpServerStatus[] {
  return load().map(status)
}

function announce(): void {
  const list = listMcp()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IpcChannel.MCP_UPDATED, list)
  }
}

async function disconnect(id: string): Promise<void> {
  const connection = connections.get(id)
  connections.delete(id)
  if (connection?.client !== null && connection?.client !== undefined) await connection.client.close().catch(() => undefined)
}

async function connect(server: StoredServer): Promise<void> {
  await disconnect(server.id)
  const connection: Connection = { client: null, state: 'connecting', error: null, tools: [] }
  connections.set(server.id, connection)
  announce()
  try {
    const transport =
      server.transport === 'stdio'
        ? new StdioTransport({
            command: server.command,
            args: server.args,
            env: { ...(process.env as Record<string, string>), PATH: await shellPath(), ...server.env },
            ...(process.platform === 'win32' ? { shell: true } : {})
          })
        : new HttpTransport(server.url, server.headers)
    const client = new McpClient(transport)
    connection.client = client
    client.onClose = (reason) => {
      if (connections.get(server.id) !== connection) return
      connection.client = null
      connection.state = 'error'
      connection.error = reason
      connection.tools = []
      announce()
    }
    client.onToolsChanged = () => {
      void client.listTools().then((tools) => {
        if (connections.get(server.id) !== connection) return
        connection.tools = tools
        announce()
      }).catch(() => undefined)
    }
    await client.connect(app.getVersion())
    connection.tools = await client.listTools()
    if (connections.get(server.id) !== connection) return
    connection.state = 'ready'
  } catch (error) {
    if (connections.get(server.id) !== connection) return
    connection.state = 'error'
    connection.error = (error as Error).message
    await connection.client?.close().catch(() => undefined)
    connection.client = null
  }
  announce()
}

/** At start-up: every enabled server starts in the background. */
export function initMcp(): void {
  for (const server of load()) if (server.enabled) void connect(server)
}

function clean(record: unknown): Record<string, string> {
  if (record === null || typeof record !== 'object') return {}
  return Object.fromEntries(
    Object.entries(record as Record<string, unknown>)
      .filter(([key, value]) => key.trim() !== '' && typeof value === 'string')
      .map(([key, value]) => [key.trim(), value as string])
  )
}

/**
 * Adds or changes a server. A secret left blank keeps the one saved, the
 * values never travel to a window, so the form cannot show them back.
 */
export async function saveMcp(input: McpServerInput): Promise<McpServerStatus[]> {
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  if (name === '') throw new Error('Give the server a name')
  const transport = input.transport === 'http' ? 'http' : 'stdio'
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  if (transport === 'stdio' && command === '') throw new Error('Name the command that starts the server')
  if (transport === 'http' && !/^https?:\/\//.test(url)) throw new Error('The server URL must start with http:// or https://')
  const list = load()
  const previous = list.find((server) => server.id === input.id)
  if (list.some((server) => server.id !== input.id && server.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`There is already a server called “${name}”`)
  }
  const keep = (next: Record<string, string>, before: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(next).map(([key, value]) => [key, value === '' ? (before[key] ?? '') : value]))
  const server: StoredServer = {
    id: previous?.id ?? randomUUID(),
    name,
    enabled: input.enabled !== false,
    transport,
    command,
    args: Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === 'string') : [],
    env: keep(clean(input.env), previous?.env ?? {}),
    url,
    headers: keep(clean(input.headers), previous?.headers ?? {}),
    trust: input.trust === true
  }
  save(previous === undefined ? [...list, server] : list.map((entry) => (entry.id === server.id ? server : entry)))
  if (server.enabled) await connect(server)
  else {
    await disconnect(server.id)
    announce()
  }
  return listMcp()
}

export async function removeMcp(id: string): Promise<McpServerStatus[]> {
  await disconnect(id)
  save(load().filter((server) => server.id !== id))
  announce()
  return listMcp()
}

export async function reconnectMcp(id: string): Promise<McpServerStatus[]> {
  const server = load().find((entry) => entry.id === id)
  if (server === undefined) throw new Error('Unknown server')
  if (server.enabled) await connect(server)
  return listMcp()
}

/**
 * Servers from the JSON other MCP clients use,
 * `{ "mcpServers": { "name": { "command", "args", "env" } | { "url", "headers" } } }`
 *, or a bare map of them. Answers how many were added.
 */
export async function importMcp(json: string): Promise<number> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('That is not valid JSON')
  }
  const map = ((parsed as { mcpServers?: unknown })?.mcpServers ?? parsed) as Record<string, unknown>
  if (map === null || typeof map !== 'object' || Array.isArray(map)) throw new Error('Expected an "mcpServers" object')
  let added = 0
  for (const [name, raw] of Object.entries(map)) {
    const entry = raw as { command?: unknown; args?: unknown; env?: unknown; url?: unknown; headers?: unknown; type?: unknown }
    const http = typeof entry?.url === 'string'
    await saveMcp({
      name,
      enabled: true,
      transport: http ? 'http' : 'stdio',
      command: typeof entry?.command === 'string' ? entry.command : '',
      args: Array.isArray(entry?.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : [],
      env: clean(entry?.env),
      url: http ? (entry.url as string) : '',
      headers: clean(entry?.headers),
      trust: false
    })
    added += 1
  }
  return added
}

/** The tools of every ready server, as the agent sees them. */
export function mcpTools(): Tool[] {
  const tools: Tool[] = []
  const taken = new Set<string>()
  for (const server of load()) {
    const connection = connections.get(server.id)
    if (!server.enabled || connection?.state !== 'ready') continue
    for (const info of connection.tools) {
      let name = mcpToolName(server.name, info.name)
      for (let n = 2; taken.has(name); n++) name = `${mcpToolName(server.name, info.name).slice(0, 60)}_${n}`
      taken.add(name)
      tools.push({
        name,
        description: `${info.description}${info.description === '' ? '' : '\n\n'}(Tool "${info.name}" from the MCP server "${server.name}".)`,
        inputSchema: toolSchema(info.inputSchema),
        // A server's state is its own business; its calls run one at a time.
        readOnly: false,
        prepare: (raw) => {
          if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
            throw new ToolError('Invalid input: expected an object of arguments')
          }
          return {
            risk: mcpRisk(server.trust, info),
            preview: async () => ({
              kind: 'text' as const,
              subject: `${server.name} · ${info.name}`,
              detail: `MCP server: ${server.name}\nTool: ${info.name}\n\n${JSON.stringify(raw ?? {}, null, 2)}`
            }),
            execute: async (context) => {
              const client = connections.get(server.id)?.client
              if (client === null || client === undefined) throw new ToolError(`The MCP server "${server.name}" is not connected`)
              const result = await client.callTool(info.name, raw ?? {}, context.signal)
              return { text: result.text === '' ? '(no output)' : result.text, images: result.images, isError: result.isError }
            }
          }
        }
      })
    }
  }
  return tools
}

/** The tokens and keys MCP servers were given, for masking in exports. */
export function mcpSecrets(): string[] {
  return load().flatMap((server) => [...Object.values(server.env), ...Object.values(server.headers)])
}

/** On quit: stop every server this app started. */
export async function closeMcp(): Promise<void> {
  await Promise.all([...connections.keys()].map((id) => disconnect(id)))
}
