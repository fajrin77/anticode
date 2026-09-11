import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpTransport, McpClient, sseMessages, StdioTransport } from './client'
import { mcpRisk, mcpToolName } from './manager'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0' }, BrowserWindow: { getAllWindows: () => [] } }))

/** A whole MCP server in a few lines: echo, a picture, a failure, and a list change. */
const SERVER = `
const rl = require('readline').createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
process.stdout.write('a log line that is not JSON\\n')
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fixture' } } })
  else if (m.method === 'tools/list' && !m.params.cursor) send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo it', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }], nextCursor: 'p2' } })
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'wipe', description: 'Delete all', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } }] } })
  else if (m.method === 'tools/call' && m.params.name === 'echo') {
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'you said ' + m.params.arguments.text }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] } })
  }
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'nope' }], isError: true } })
  else if (m.method === 'quit') process.exit(3)
})
`

const clients: McpClient[] = []
let http: Server | null = null
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  http?.close()
  http = null
})

describe('MCP over stdio', () => {
  it('shakes hands, pages through tools, calls one, and hears of list changes', async () => {
    const client = new McpClient(new StdioTransport({ command: process.execPath, args: ['-e', SERVER], env: { ...process.env } as Record<string, string> }))
    clients.push(client)
    const changed = vi.fn()
    client.onToolsChanged = changed
    await client.connect('1.0.0')
    expect(client.serverName).toBe('fixture')
    const tools = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'wipe'])
    const result = await client.callTool('echo', { text: 'halo' }, new AbortController().signal)
    expect(result).toEqual({ text: 'you said halo', images: [{ mediaType: 'image/png', data: 'AAAA' }], isError: false })
    expect(changed).toHaveBeenCalled()
    expect((await client.callTool('wipe', {}, new AbortController().signal)).isError).toBe(true)
  })

  it('reports a server that goes away, with what it said', async () => {
    const client = new McpClient(new StdioTransport({ command: process.execPath, args: ['-e', SERVER], env: { ...process.env } as Record<string, string> }))
    clients.push(client)
    await client.connect('1.0.0')
    const closed = new Promise<string>((resolve) => { client.onClose = resolve })
    await expect((client as unknown as { request: (method: string, params: unknown) => Promise<unknown> }).request('quit', {})).rejects.toThrow(/exited/)
    expect(await closed).toMatch(/code 3/)
  })

  it('says so when the command does not exist', async () => {
    const client = new McpClient(new StdioTransport({ command: 'definitely-not-a-command-xyz', args: [], env: {} }))
    await expect(client.connect('1.0.0')).rejects.toThrow(/Could not start/)
  })
})

describe('MCP over Streamable HTTP', () => {
  it('keeps the session id and reads answers sent as an event stream', async () => {
    const seen: (string | undefined)[] = []
    http = createServer(async (req, res) => {
      if (req.method === 'DELETE') { res.writeHead(204).end(); return }
      let raw = ''
      for await (const chunk of req) raw += chunk
      seen.push(req.headers['mcp-session-id'] as string | undefined)
      const m = JSON.parse(raw)
      if (m.id === undefined) { res.writeHead(202).end(); return }
      if (m.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'abc' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name: 'web' } } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'search', inputSchema: { type: 'object' } }] } })}\n\n`)
    })
    await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', resolve))
    const address = http.address() as { port: number }
    const client = new McpClient(new HttpTransport(`http://127.0.0.1:${address.port}/mcp`, { authorization: 'Bearer t' }))
    clients.push(client)
    await client.connect('1.0.0')
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(['search'])
    expect(seen).toEqual([undefined, 'abc', 'abc'])
  })

  it('reads several events from one body', () => {
    expect(sseMessages('data: {"jsonrpc":"2.0","id":1}\n\n: ping\n\ndata: {"jsonrpc":"2.0","id":2}\n\n').map((m) => m.id)).toEqual([1, 2])
  })
})

describe('MCP tools in anticode', () => {
  it('names tools the way providers accept', () => {
    expect(mcpToolName('GitHub Server', 'create issue!')).toBe('mcp__GitHub_Server__create_issue')
    expect(mcpToolName('x', 'y'.repeat(100))).toHaveLength(64)
  })

  it('asks for every call unless the server is trusted, and always for destructive tools', () => {
    expect(mcpRisk(false, {})).toBe('medium')
    expect(mcpRisk(false, { annotations: { destructiveHint: true } })).toBe('high')
    expect(mcpRisk(true, { annotations: { destructiveHint: true } })).toBe('low')
  })
})
