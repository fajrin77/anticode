import { beginRun, finishRun, cancelRun, cancelSessionRuns, runForSession } from '../runs'
import http from 'node:http'
import os from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentEvent, RemoteStatus, RoutedAgentEvent, SessionMode } from '@shared/ipc'
import { isIgnoredEntry } from '../tools/ignore'
import { resolveInWorkspace } from '../tools/workspace'
import { listProviders } from '../providers'
import {
  listModels,
  persistSessions,
  createRemoteSession,
  deleteSession,
  getSession,
  getStatus,
  listSessionSummaries,
  loadSessionMessages,
  selectProvider,
  sessionWorkspaceRoot
} from '../runtime'
import { approvals } from '../ipc'
import { forgetRun, forward, registerRun, subscribe } from './bus'
import { loadPersistedSettings, savePersistedSettings } from '../settings'

const PORT = Number(process.env['ANTICODE_REMOTE_PORT'] || 8680)

let server: http.Server | null = null
let lastError: string | null = null
const eventStreams = new Set<http.ServerResponse>()
let transition: Promise<unknown> = Promise.resolve()

export function getRemoteStatus(): RemoteStatus {
  const persisted = loadPersistedSettings().remote
  if (persisted?.enabled !== true) {
    return { enabled: false, url: null, token: null, error: null }
  }
  if (lastError !== null) {
    return { enabled: true, url: null, token: null, error: lastError }
  }
  const ip = lanAddress() ?? '<your-mac-ip>'
  return {
    enabled: true,
    url: `http://${ip}:${typeof server?.address() === 'object' ? (server.address() as { port: number } | null)?.port ?? PORT : PORT}/?token=${persisted.token}`,
    token: persisted.token,
    error: null
  }
}

function lanAddress(): string | null {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return null
}

export function setRemoteEnabled(enabled: boolean, port = PORT): Promise<RemoteStatus> {
  const result = transition.then(() => changeRemoteEnabled(enabled, port))
  transition = result.catch(() => undefined)
  return result
}
async function changeRemoteEnabled(enabled: boolean, port: number): Promise<RemoteStatus> {
  if (!enabled) {
    await closeServer()
    savePersistedSettings({
      remote: { enabled: false, token: persistedToken(), port: PORT }
    })
    return getRemoteStatus()
  }

  if (server?.listening) return getRemoteStatus()
  lastError = null
  const token = persistedToken()
  savePersistedSettings({ remote: { enabled: true, token, port: PORT } })

  server = http.createServer((req, res) => {
    void handle(req, res)
  })
  const httpServer = server
  httpServer.on('error', (error) => {
    lastError = (error as Error).message
  })
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(port, '0.0.0.0', () => { httpServer.off('error', reject); resolve() })
    })
  } catch (error) {
    lastError = (error as Error).message
    server = null
  }
  return getRemoteStatus()
}

async function closeServer(): Promise<void> {
  const existing = server
  if (existing === null) return
  server = null
  for (const stream of eventStreams) stream.end()
  await new Promise<void>((resolve) => {
    existing.close(() => resolve())
    existing.closeAllConnections()
  })
}

/** Auto-start on boot when the persisted flag says so. */
export async function restoreRemoteServer(): Promise<void> {
  if (loadPersistedSettings().remote?.enabled === true) {
    await setRemoteEnabled(true)
  }
}

/** Issues a fresh pairing token; old links die instantly because every
 * request re-reads the persisted settings. The server itself stays up. */
export async function regenerateRemoteToken(): Promise<RemoteStatus> {
  for (const stream of eventStreams) stream.end()
  const enabled = loadPersistedSettings().remote?.enabled === true
  savePersistedSettings({
    remote: { enabled, token: randomUUID().replace(/-/g, ''), port: PORT }
  })
  return getRemoteStatus()
}

function persistedToken(): string {
  const existing = loadPersistedSettings().remote?.token
  if (existing !== undefined && existing !== '') return existing
  const token = randomUUID().replace(/-/g, '')
  savePersistedSettings({ remote: { enabled: false, token, port: PORT } })
  return token
}

function authorised(url: URL, req: http.IncomingMessage): boolean {
  const expected = loadPersistedSettings().remote?.token
  if (expected === undefined) return false
  const query = url.searchParams.get('token')
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  return query === expected || header === expected
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!authorised(url, req)) return deny(res)
      const html = await readFile(
        path.join(import.meta.dirname, 'remote/public/index.html'),
        'utf8'
      )
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    if (!url.pathname.startsWith('/api/') || !authorised(url, req)) {
      return deny(res)
    }

    const body = await readBody(req)

    if (req.method === 'GET' && url.pathname === '/api/ping') {
      return json(res, 200, { ok: true, status: getStatus() })
    }

    if (req.method === 'GET' && url.pathname === '/api/overview') {
      return json(res, 200, { status: getStatus(), sessions: listSessionSummaries() })
    }

    if (req.method === 'GET' && url.pathname === '/api/models') {
      return json(res, 200, await modelsPayload())
    }

    if (req.method === 'POST' && url.pathname === '/api/model') {
      const provider = typeof body.provider === 'string' ? body.provider : ''
      const model = typeof body.model === 'string' ? body.model : ''
      if (provider === '') return json(res, 400, { error: 'provider is required' })
      if (model === '') await listModels(provider)
      selectProvider({ provider, model })
      return json(res, 200, { ok: true, status: getStatus() })
    }

    if (req.method === 'POST' && url.pathname === '/api/session') {
      return json(res, 200, createPhoneSession(body))
    }

    const sessionMatch = /\/api\/session\/([\w-]+)$/.exec(url.pathname)
    if (req.method === 'GET' && sessionMatch !== null) {
      const messages = loadSessionMessages(sessionMatch[1] ?? '')
      if (messages === null) return json(res, 404, { error: 'Unknown session' })
      return json(res, 200, { messages, runId: runForSession(sessionMatch[1] ?? '') })
    }

    if (req.method === 'DELETE' && sessionMatch !== null) {
      const id = sessionMatch[1] ?? ''
      cancelSessionRuns(id)
      deleteSession(id)
      return json(res, 200, { ok: true })
    }

    if (req.method === 'POST' && url.pathname === '/api/prompt') {
      return json(res, 200, await startPrompt(body))
    }

    if (req.method === 'GET' && url.pathname === '/api/approvals') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const runId = runForSession(sessionId)
      return json(res, 200, { requests: approvals.listPending().filter((request) => request.runId === runId) })
    }
    if (req.method === 'POST' && url.pathname === '/api/approval') {
      if (typeof body.requestId !== 'string' || !['approve', 'reject', 'always'].includes(String(body.decision))) throw new Error('Invalid approval response')
      const pending = approvals.listPending().find((request) => request.requestId === body.requestId)
      if (!pending) throw new Error('This approval is no longer pending')
      approvals.resolve(body.requestId, body.decision as 'approve' | 'reject' | 'always')
      return json(res, 200, { ok: true })
    }

    if (req.method === 'POST' && url.pathname === '/api/cancel') {
      const runId = typeof body.runId === 'string' ? body.runId : ''
      cancelRun(runId)
      return json(res, 200, { ok: true })
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      return openEventStream(url, res)
    }

    const filesMatch = /\/api\/files$/.test(url.pathname)
    if (filesMatch && req.method === 'GET') {
      return json(res, 200, await readWorkspaceFile(String(body.sessionId ?? url.searchParams.get('sessionId') ?? ''), url.searchParams.get('path') ?? '.'))
    }
    if (filesMatch && req.method === 'POST') {
      return json(res, 200, await writeWorkspaceFile(String(body.sessionId ?? ''), String(body.path ?? ''), typeof body.content === 'string' ? body.content : '', typeof body.version === 'string' ? body.version : null))
    }

    if (req.method === 'POST' && url.pathname === '/api/git') {
      return json(res, 200, await runGit(String(body.sessionId ?? ''), String(body.action ?? ''), typeof body.message === 'string' ? body.message : ''))
    }

    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    json(res, 400, { error: (error as Error).message })
  }
}

function deny(res: http.ServerResponse): void {
  res.writeHead(401, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'Unauthorised — open the pairing URL' }))
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 2 * 1024 * 1024) throw new Error('Request too large (limit 2 MB)')
    chunks.push(Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  const body: unknown = raw === '' ? {} : JSON.parse(raw)
  if (body === null || Array.isArray(body) || typeof body !== 'object') throw new Error('Expected a JSON object')
  return body as Record<string, unknown>
}

/** Provider list plus the catalogue of the current provider, for the phone picker. */
async function modelsPayload(): Promise<{
  provider: string
  model: string
  providers: { id: string; label: string; available: boolean; models: string[] }[]
}> {
  const status = getStatus()
  const catalogue = await listModels(status.provider)
  const providers = listProviders().map((entry) => ({
    id: entry.id,
    label: entry.label,
    available: entry.credentialAvailable,
    models: entry.id === status.provider ? catalogue.models : []
  }))
  return { provider: status.provider, model: status.model, providers }
}

/** Creates a session straight from the phone, validating the folder up front. */
function createPhoneSession(body: Record<string, unknown>): { sessionId: string } {
  const mode: SessionMode = body.mode === 'chat' ? 'chat' : 'code'
  const folder = typeof body.folder === 'string' && body.folder.trim() !== '' ? body.folder.trim() : null
  if (mode === 'chat') return { sessionId: createRemoteSession('chat', null) }

  if (folder === null || !existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new Error('Folder not found on the Mac — check the path')
  }
  return { sessionId: createRemoteSession('code', folder) }
}

async function startPrompt(body: Record<string, unknown>): Promise<{
  sessionId: string
  runId: string
}> {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (prompt === '') throw new Error('Prompt is empty')

  const status = getStatus()
  if (!status.providerReady) throw new Error(status.blockedReason ?? 'Provider is not ready')
  let sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (sessionId !== '' && loadSessionMessages(sessionId) === null) throw new Error('Unknown session')
  if (sessionId === '') sessionId = createPhoneSession(body).sessionId
  const agent = getSession(sessionId, approvals)
  const runId = randomUUID()
  const controller = beginRun(runId, sessionId)
  registerRun(runId, sessionId)
  forward({ type: 'prompt', runId, text: prompt, sessionId } as RoutedAgentEvent)
  void agent.run({
    runId, prompt, signal: controller.signal,
    emit: (event: AgentEvent) => forward({ ...event, sessionId } as RoutedAgentEvent)
  }).catch((error: Error) => {
    forward({ type: 'error', runId, message: error.message, sessionId } as RoutedAgentEvent)
  }).finally(() => {
    forgetRun(runId)
    finishRun(runId)
    persistSessions()
  })

  return { sessionId, runId }
}

function openEventStream(url: URL, res: http.ServerResponse): void {
  const sessionId = url.searchParams.get('sessionId') ?? ''
  if (loadSessionMessages(sessionId) === null) { json(res, 404, { error: 'Unknown session' }); return }
  eventStreams.add(res)
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  res.write(': connected\n\n')
  const send = (event: AgentEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  const unsubscribe = subscribe(sessionId, send)
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)
  res.on('close', () => {
    eventStreams.delete(res)
    clearInterval(heartbeat)
    unsubscribe()
  })
}

async function readWorkspaceFile(sessionId: string, relativePath: string): Promise<unknown> {
  const root = sessionWorkspaceRoot(sessionId)
  if (root === null) throw new Error('This session has no project folder')
  const target = resolveInWorkspace(root, relativePath)
  const info = await stat(target)
  if (info.isDirectory()) {
    const entries = await readdir(target, { withFileTypes: true })
    return {
      kind: 'directory',
      path: relativePath,
      entries: entries
        .filter((entry) => !isIgnoredEntry(entry.name, entry.isDirectory()))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort((a, b) => a.localeCompare(b))
    }
  }
  if (info.size > 2 * 1024 * 1024) throw new Error('File too large for the editor (limit 2 MB)')
  const content = await readFile(target, 'utf8')
  if (content.includes('\0')) throw new Error('Binary files cannot be edited as text')
  return { kind: 'file', path: relativePath, content, version: createHash('sha256').update(content).digest('hex') }
}

async function writeWorkspaceFile(sessionId: string, relativePath: string, content: string, version: string | null): Promise<unknown> {
  const root = sessionWorkspaceRoot(sessionId)
  if (root === null) throw new Error('This session has no project folder')
  const target = resolveInWorkspace(root, relativePath)
  if (runForSession(sessionId) !== null) throw new Error('Wait for the agent to finish before editing files')
  const current = await readFile(target, 'utf8')
  if (version === null || createHash('sha256').update(current).digest('hex') !== version) throw new Error('File changed since it was opened. Reload it before saving.')
  await writeFile(target, content, 'utf8')
  return { ok: true, path: relativePath, bytes: Buffer.byteLength(content), version: createHash('sha256').update(content).digest('hex') }
}

function runGit(sessionId: string, action: string, message: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const root = sessionWorkspaceRoot(sessionId)
    if (root === null) {
      reject(new Error('This session has no project folder'))
      return
    }
    const args =
      action === 'status'
        ? ['status', '--porcelain', '-b']
        : action === 'commit'
          ? ['commit', '-m', message !== '' ? message : 'Update from anticode remote']
          : action === 'push'
            ? ['push']
            : []
    if (args.length === 0) {
      reject(new Error('Unknown git action'))
      return
    }
    const steps = action === 'commit' ? [['add', '-A'], ['commit', '-m', message !== '' ? message : 'Update from anticode remote']] : [args]
    let output = ''
    let index = 0
    const next = (): void => {
      if (index >= steps.length) {
        resolve({ ok: true, action, output: output.trim() })
        return
      }
      const step = steps[index]
      index += 1
      execFile('git', step, { cwd: root, timeout: 30_000 }, (error, stdout, stderr) => {
        output += `${stdout}${stderr}`
        if (error !== null) {
          resolve({ ok: false, action, output: `${output}${stderr}${error.message}`.trim() })
          return
        }
        next()
      })
    }
    next()
  })
}
