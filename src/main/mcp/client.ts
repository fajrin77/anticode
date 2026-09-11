import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/*
 * A Model Context Protocol client, just big enough for tools: the initialize
 * handshake, tools/list (paged), tools/call, ping, and the list_changed
 * notification. Two transports — a local process spoken to over stdio, one
 * JSON message per line, and a remote server over Streamable HTTP, whose
 * answers come back as plain JSON or as a short server-sent-event stream.
 */

export const PROTOCOL_VERSION = '2025-06-18'
const REQUEST_TIMEOUT_MS = 60_000
const STDERR_KEPT = 4_000

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string }
}

export interface McpContent {
  text: string
  images: { mediaType: string; data: string }[]
  isError: boolean
}

type JsonRpcMessage = {
  jsonrpc: '2.0'
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface Transport {
  start: (onMessage: (message: JsonRpcMessage) => void, onClose: (reason: string) => void) => Promise<void>
  send: (message: JsonRpcMessage) => Promise<void>
  close: () => Promise<void>
}

export interface StdioOptions {
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  /** Windows finds `npx` only as `npx.cmd`, which needs a shell to resolve. */
  shell?: boolean
}

/** A server that runs as a child process; messages are lines of JSON. */
export class StdioTransport implements Transport {
  private child: ChildProcessWithoutNullStreams | null = null
  private stderr = ''

  constructor(private readonly options: StdioOptions) {}

  async start(onMessage: (message: JsonRpcMessage) => void, onClose: (reason: string) => void): Promise<void> {
    const child = spawn(this.options.command, this.options.args, {
      env: this.options.env,
      ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: this.options.shell === true
    })
    this.child = child
    let buffered = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk
      let newline = buffered.indexOf('\n')
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (line !== '') {
          try {
            onMessage(JSON.parse(line) as JsonRpcMessage)
          } catch { /* A server's stray log line on stdout is not a message. */ }
        }
        newline = buffered.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEPT)
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', (error) => reject(new Error(`Could not start ${this.options.command}: ${error.message}`)))
    })
    child.on('exit', (code, signal) => {
      const tail = this.stderr.trim().split('\n').slice(-3).join(' ').slice(-400)
      onClose(`The server exited (${signal ?? `code ${code}`})${tail !== '' ? `: ${tail}` : ''}`)
    })
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.child === null || this.child.stdin.destroyed) throw new Error('The server is not running')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  async close(): Promise<void> {
    const child = this.child
    this.child = null
    if (child === null || child.exitCode !== null) return
    child.stdin.end()
    child.kill('SIGTERM')
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 2_000).unref()
  }
}

/** Reads `data:` payloads out of a server-sent-event body. */
export function sseMessages(body: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = []
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (data === '') continue
    try {
      messages.push(JSON.parse(data) as JsonRpcMessage)
    } catch { /* A keep-alive or malformed event carries nothing. */ }
  }
  return messages
}

/** A remote server over Streamable HTTP: every message is a POST. */
export class HttpTransport implements Transport {
  private session: string | null = null
  private deliver: ((message: JsonRpcMessage) => void) | null = null

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>
  ) {}

  async start(onMessage: (message: JsonRpcMessage) => void): Promise<void> {
    this.deliver = onMessage
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        ...(this.session !== null ? { 'mcp-session-id': this.session } : {}),
        ...this.headers
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 5)
    })
    const session = response.headers.get('mcp-session-id')
    if (session !== null) this.session = session
    if (response.status === 202 || response.status === 204) return
    const body = await response.text()
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}${response.status === 401 ? ' — the server wants credentials; add them as a header' : ''}: ${body.slice(0, 200)}`)
    }
    const type = response.headers.get('content-type') ?? ''
    const messages = type.includes('text/event-stream')
      ? sseMessages(body)
      : body.trim() === ''
        ? []
        : ([] as JsonRpcMessage[]).concat(JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[])
    for (const received of messages) this.deliver?.(received)
  }

  async close(): Promise<void> {
    if (this.session === null) return
    // Ending the session is a courtesy; a server that ignores it is fine.
    await fetch(this.url, { method: 'DELETE', headers: { 'mcp-session-id': this.session, ...this.headers }, signal: AbortSignal.timeout(3_000) }).catch(() => undefined)
    this.session = null
  }
}

export class McpClient {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private closed = false
  /** Told when the server's tool list changes, or when it goes away. */
  onToolsChanged: (() => void) | null = null
  onClose: ((reason: string) => void) | null = null
  serverName = ''

  constructor(private readonly transport: Transport) {}

  async connect(clientVersion: string): Promise<void> {
    await this.transport.start(
      (message) => this.receive(message),
      (reason) => this.fail(reason)
    )
    const result = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'anticode', version: clientVersion }
    })) as { serverInfo?: { name?: string } }
    this.serverName = result?.serverInfo?.name ?? ''
    await this.notify('notifications/initialized')
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const result = (await this.request('tools/list', cursor !== undefined ? { cursor } : {})) as {
        tools?: McpToolInfo[]
        nextCursor?: string
      }
      for (const tool of result?.tools ?? []) {
        if (typeof tool?.name !== 'string') continue
        tools.push({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema:
            tool.inputSchema !== null && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
          ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {})
        })
      }
      if (typeof result?.nextCursor !== 'string' || result.nextCursor === '') break
      cursor = result.nextCursor
    }
    return tools
  }

  async callTool(name: string, args: unknown, signal: AbortSignal): Promise<McpContent> {
    const result = (await this.request('tools/call', { name, arguments: args ?? {} }, signal)) as {
      content?: { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } }[]
      structuredContent?: unknown
      isError?: boolean
    }
    const texts: string[] = []
    const images: McpContent['images'] = []
    for (const item of result?.content ?? []) {
      if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text)
      else if (item.type === 'image' && typeof item.data === 'string') images.push({ mediaType: item.mimeType ?? 'image/png', data: item.data })
      else if (item.type === 'resource' && typeof item.resource?.text === 'string') texts.push(item.resource.text)
      else if (item.type === 'resource_link' || item.type === 'resource') texts.push(`[resource ${item.resource?.uri ?? ''}]`)
    }
    if (texts.length === 0 && result?.structuredContent !== undefined) texts.push(JSON.stringify(result.structuredContent, null, 2))
    return { text: texts.join('\n'), images, isError: result?.isError === true }
  }

  async close(): Promise<void> {
    this.fail('Disconnected')
    await this.transport.close()
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('The server is not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, method === 'tools/call' ? REQUEST_TIMEOUT_MS * 5 : REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      const abort = (): void => {
        const entry = this.pending.get(id)
        if (entry === undefined) return
        clearTimeout(entry.timer)
        this.pending.delete(id)
        void this.notify('notifications/cancelled', { requestId: id, reason: 'Cancelled by the user' }).catch(() => undefined)
        reject(new Error('Cancelled by the user'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.transport.send({ jsonrpc: '2.0', id, method, params }).catch((error: Error) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private notify(method: string, params?: unknown): Promise<void> {
    return this.transport.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
  }

  private receive(message: JsonRpcMessage): void {
    if (message.method !== undefined) {
      // A request from the server. Only ping is answered; this client offers
      // no sampling, roots, or elicitation.
      if (message.id !== undefined && message.id !== null) {
        const reply: JsonRpcMessage =
          message.method === 'ping'
            ? { jsonrpc: '2.0', id: message.id, result: {} }
            : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `${message.method} is not supported by anticode` } }
        void this.transport.send(reply).catch(() => undefined)
      } else if (message.method === 'notifications/tools/list_changed') {
        this.onToolsChanged?.()
      }
      return
    }
    if (typeof message.id !== 'number') return
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error !== undefined) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  }

  private fail(reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    this.pending.clear()
    this.onClose?.(reason)
  }
}
