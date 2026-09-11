import {
  cancelRun,
  cancelSessionRuns,
  pauseSession,
  listActiveRuns,
  runForSession
} from '../runs'
import http from 'node:http'
import os from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  ProviderEdit,
  ProviderSelection,
  RemoteStatus,
  RotationEntryStatus,
  RotationGroup,
  SessionMode
} from '@shared/ipc'
import { ROTATE_PROVIDER } from '@shared/ipc'
import { isIgnoredEntry } from '../tools/ignore'
import { resolveInWorkspace } from '../tools/workspace'
import { listProviders } from '../providers'
import { cleanModelIds } from '../providers/custom'
import {
  listModels,
  createRemoteSession,
  deleteSession,
  getStatus,
  listSessionSummaries,
  loadSessionMessages,
  revertLastTurn,
  sessionFileRoot,
  sessionWorkspaceRoot
} from '../runtime'
import {
  addProvider,
  approvals,
  enableRotation,
  pickModel,
  removeProvider,
  resetRotation,
  selectRotationGroup,
  setApprovalMode,
  setRotation,
  setRotationGroups,
  updateProvider
} from '../ipc'
import {
  registerAttachmentData,
} from '../attachments/registry'
import { announceHistory, sessionSnapshot, subscribe } from './bus'
import type { StreamEvent } from './bus'
import {
  activeWebUrl,
  addWebTab,
  closeWebTab,
  listWeb,
  openWeb,
  selectWebTab,
  setWebVisible,
  stepWebHistory,
  webHistoryOf
} from '../web'
import { capturePhonePage } from '../browser'
import { submitPrompt } from '../prompts'
import { previewFile } from '../preview'
import sharp from 'sharp'
import { loadPersistedSettings, savePersistedSettings } from '../settings'

const PORT = Number(process.env['ANTICODE_REMOTE_PORT'] || 8680)
const BODY_LIMIT = 2 * 1024 * 1024
/** Room for a phone photo; the attachment handler enforces its own 20 MB cap. */
const UPLOAD_LIMIT = 28 * 1024 * 1024

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

    const body = await readBody(req, url.pathname === '/api/attachment' ? UPLOAD_LIMIT : BODY_LIMIT)

    if (req.method === 'GET' && url.pathname === '/api/ping') {
      return json(res, 200, { ok: true, status: getStatus() })
    }

    if (req.method === 'GET' && url.pathname === '/api/overview') {
      return json(res, 200, {
        status: getStatus(),
        sessions: listSessionSummaries(),
        ...webPayload()
      })
    }

    if (req.method === 'GET' && url.pathname === '/api/web') {
      return json(res, 200, webPayload())
    }

    // The phone is on the other side of the network from every localhost the
    // agent serves, so it cannot embed the page the desktop embeds. It gets a
    // mobile rendering of the active URL from a separate browser context.
    if (req.method === 'GET' && url.pathname === '/api/web/shot') {
      return sendWebShot(
        res,
        url.searchParams.get('sessionId') ?? '',
        url.searchParams.get('reload') === '1'
      )
    }

    if (req.method === 'POST' && url.pathname === '/api/web') {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (loadSessionMessages(sessionId) === null) return json(res, 404, { error: 'Unknown session' })
      const tabId = typeof body.tabId === 'string' ? body.tabId : undefined
      if (body.action === 'newTab') addWebTab(sessionId, typeof body.url === 'string' ? body.url : '')
      else if (body.action === 'closeTab' && tabId !== undefined) closeWebTab(sessionId, tabId)
      else if (body.action === 'selectTab' && tabId !== undefined) selectWebTab(sessionId, tabId)
      else if (body.action === 'back') stepWebHistory(sessionId, -1)
      else if (body.action === 'forward') stepWebHistory(sessionId, 1)
      else if (typeof body.url === 'string') openWeb(sessionId, body.url, tabId)
      else if (typeof body.visible === 'boolean') setWebVisible(sessionId, body.visible)
      return json(res, 200, webPayload())
    }

    // Default or Auto: the same switch as the desktop's composer chip, and the
    // one policy every prompt obeys, wherever it was sent from.
    if (req.method === 'POST' && url.pathname === '/api/policy') {
      if (typeof body.autoApprove !== 'boolean') return json(res, 400, { error: 'autoApprove must be true or false' })
      return json(res, 200, { status: setApprovalMode(body.autoApprove) })
    }

    // Providers, managed from either screen: added, edited, removed, and
    // Clinepass restored (kind 'clinepass') after being removed.
    if (req.method === 'POST' && url.pathname === '/api/providers') {
      const kinds = ['ollama', 'clinepass', 'anthropic', 'openai-api'] as const
      const kind = kinds.find((entry) => entry === body.kind) ?? 'openai'
      const text = (value: unknown): string => (typeof value === 'string' ? value : '')
      // A vendor API defaults to its own address; a gateway has none to default to.
      if ((kind === 'openai' || kind === 'ollama') && text(body.baseURL).trim() === '') return json(res, 400, { error: 'Base URL is required' })
      if (kind !== 'ollama' && kind !== 'clinepass' && text(body.apiKey).trim() === '') return json(res, 400, { error: 'API key is required' })
      addProvider({ label: text(body.label), kind, baseURL: text(body.baseURL), apiKey: text(body.apiKey), models: cleanModelIds(body.models) })
      return json(res, 200, await modelsPayload())
    }
    const providerMatch = /^\/api\/providers\/(.+)$/.exec(url.pathname)
    if (providerMatch !== null && (req.method === 'POST' || req.method === 'DELETE')) {
      const id = decodeURIComponent(providerMatch[1] ?? '')
      if (!listProviders().some((entry) => entry.id === id)) return json(res, 404, { error: 'Unknown provider' })
      if (req.method === 'DELETE') removeProvider(id)
      else await updateProvider(id, providerEdit(body))
      return json(res, 200, await modelsPayload())
    }

    if (req.method === 'GET' && url.pathname === '/api/models') {
      return json(res, 200, await modelsPayload(url.searchParams.get('sessionId')))
    }

    // With a session id only that session changes model, as on the desktop;
    // without one (the new-session card) it is the model new sessions start on.
    if (req.method === 'POST' && url.pathname === '/api/model') {
      const provider = typeof body.provider === 'string' ? body.provider : ''
      const model = typeof body.model === 'string' ? body.model : ''
      const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : null
      if (provider === '') return json(res, 400, { error: 'provider is required' })
      if (model === '' && provider !== ROTATE_PROVIDER) await listModels(provider)
      pickModel({ provider, model }, sessionId)
      return json(res, 200, { ok: true, status: getStatus() })
    }

    // Rotate usage: switched on or off, the pool or its groups replaced, a
    // group put in use, or its token counts started over.
    if (req.method === 'POST' && url.pathname === '/api/rotation') {
      if (typeof body.enabled === 'boolean') enableRotation(body.enabled)
      else if (body.reset === true) resetRotation()
      else if ('group' in body) selectRotationGroup(body.group)
      else if ('groups' in body) setRotationGroups(body.groups)
      else setRotation(body.entries)
      return json(res, 200, await modelsPayload(typeof body.sessionId === 'string' ? body.sessionId : null))
    }

    if (req.method === 'POST' && url.pathname === '/api/session') {
      return json(res, 200, createPhoneSession(body))
    }

    const sessionMatch = /\/api\/session\/([\w-]+)$/.exec(url.pathname)
    if (req.method === 'GET' && sessionMatch !== null) {
      const snapshot = sessionSnapshot(sessionMatch[1] ?? '')
      if (snapshot === null) return json(res, 404, { error: 'Unknown session' })
      return json(res, 200, snapshot)
    }

    if (req.method === 'DELETE' && sessionMatch !== null) {
      const id = sessionMatch[1] ?? ''
      cancelSessionRuns(id)
      deleteSession(id)
      return json(res, 200, { ok: true })
    }

    if (req.method === 'POST' && url.pathname === '/api/attachment') {
      const name = typeof body.name === 'string' && body.name !== '' ? body.name : 'attachment'
      if (typeof body.data !== 'string') throw new Error('Attachment data is missing')
      const [prepared] = await registerAttachmentData(name, Buffer.from(body.data, 'base64'))
      if (prepared === undefined) throw new Error('Attachment could not be read')
      return json(res, 200, {
        id: prepared.id,
        name: prepared.name,
        kind: prepared.kind,
        size: prepared.size,
        thumbnail: prepared.thumbnail
      })
    }

    // The picture itself, so the phone can open an attachment rather than
    // squint at its thumbnail. Only paths the session's own history names are
    // served — the allowlist is the transcript, not the filesystem.
    if (req.method === 'GET' && url.pathname === '/api/attachment') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (loadSessionMessages(sessionId) === null) return json(res, 404, { error: 'Unknown session' })
      return sendFile(res, attachmentPath(sessionId, url.searchParams.get('path') ?? ''))
    }

    // A file looked at on the phone instead of downloaded to be opened
    // elsewhere. Documents come back rendered, the same pages the desktop
    // draws; /api/view is the file itself, inline, for pictures and PDFs.
    if (req.method === 'GET' && (url.pathname === '/api/preview' || url.pathname === '/api/view')) {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (loadSessionMessages(sessionId) === null) return json(res, 404, { error: 'Unknown session' })
      const requested = url.searchParams.get('path') ?? ''
      const target = url.searchParams.get('attachment') === '1'
        ? attachmentPath(sessionId, requested)
        : producedPath(sessionId, requested)
      if (url.pathname === '/api/view') return sendFile(res, target)
      return json(res, 200, await previewFile(target, false))
    }

    if (req.method === 'GET' && url.pathname === '/api/download') {
      return sendDownload(
        res,
        url.searchParams.get('sessionId') ?? '',
        url.searchParams.get('path') ?? ''
      )
    }

    if (req.method === 'POST' && url.pathname === '/api/prompt') {
      return json(res, 200, await startPrompt(body))
    }

    if (req.method === 'POST' && url.pathname === '/api/revert') {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (loadSessionMessages(sessionId) === null) return json(res, 404, { error: 'Unknown session' })
      const prompt = revertLastTurn(sessionId)
      announceHistory(sessionId, 'phone')
      return json(res, 200, { prompt })
    }

    if (req.method === 'GET' && url.pathname === '/api/approvals') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const runId = runForSession(sessionId)
      // The phone polls this every second while a session is open, so it also
      // serves as the heartbeat telling it the session is still there — a
      // delete on the desktop would otherwise leave it on a dead screen.
      return json(res, 200, {
        exists: sessionId === '' || loadSessionMessages(sessionId) !== null,
        status: getStatus(),
        requests: approvals.listPending().filter((request) => request.runId === runId)
      })
    }
    if (req.method === 'POST' && url.pathname === '/api/approval') {
      if (typeof body.requestId !== 'string' || !['approve', 'reject', 'always'].includes(String(body.decision))) throw new Error('Invalid approval response')
      const pending = approvals.listPending().find((request) => request.requestId === body.requestId)
      if (!pending) throw new Error('This approval is no longer pending')
      approvals.resolve(body.requestId, body.decision as 'approve' | 'reject' | 'always')
      return json(res, 200, { ok: true })
    }

    // The same pause the desktop presses; every viewer hears of it, and either
    // one can resume it.
    if (req.method === 'POST' && url.pathname === '/api/pause') {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (loadSessionMessages(sessionId) === null) return json(res, 404, { error: 'Unknown session' })
      return json(res, 200, { paused: pauseSession(sessionId) })
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

/**
 * The mirror is captured at a phone's own width and its whole scrollable
 * height, so the phone scrolls the page rather than squinting at all of it at
 * once. 780 is enough for a retina phone without sending a poster.
 */
const SHOT_WIDTH = 780
/** A page that scrolls forever must not become a picture that downloads forever. */
const SHOT_MAX_HEIGHT = 12_000

async function sendWebShot(
  res: http.ServerResponse,
  sessionId: string,
  reload: boolean
): Promise<void> {
  const target = activeWebUrl(sessionId)
  if (target === null) return json(res, 404, { error: 'No page is open in this session' })
  try {
    const raw = await capturePhonePage(sessionId, target, reload)
    const scaled = sharp(raw).resize({ width: SHOT_WIDTH, withoutEnlargement: true })
    const size = await scaled.toBuffer({ resolveWithObject: true })
    const picture =
      size.info.height > SHOT_MAX_HEIGHT
        ? await sharp(size.data)
            .extract({ left: 0, top: 0, width: size.info.width, height: SHOT_MAX_HEIGHT })
            .jpeg({ quality: 72 })
            .toBuffer()
        : await sharp(size.data).jpeg({ quality: 72 }).toBuffer()
    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': String(picture.byteLength),
      'cache-control': 'no-store'
    })
    res.end(picture)
  } catch (error) {
    json(res, 502, { error: (error as Error).message })
  }
}

/** The panes, and for each one whether its active tab can go Back or Forward. */
function webPayload(): { web: ReturnType<typeof listWeb>; history: Record<string, { back: boolean; forward: boolean }> } {
  const web = listWeb()
  return { web, history: Object.fromEntries(web.map((entry) => [entry.sessionId, webHistoryOf(entry.sessionId)])) }
}

function deny(res: http.ServerResponse): void {
  res.writeHead(401, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'Unauthorised — open the pairing URL' }))
}

async function readBody(
  req: http.IncomingMessage,
  limit = BODY_LIMIT
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > limit) throw new Error(`Request too large (limit ${Math.round(limit / 1024 / 1024)} MB)`)
    chunks.push(Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  const body: unknown = raw === '' ? {} : JSON.parse(raw)
  if (body === null || Array.isArray(body) || typeof body !== 'object') throw new Error('Expected a JSON object')
  return body as Record<string, unknown>
}

/** A provider edit from the phone: only the fields it sent, as strings. */
function providerEdit(body: Record<string, unknown>): ProviderEdit {
  const edit: ProviderEdit = {}
  for (const key of ['label', 'baseURL', 'apiKey'] as const) {
    const value = body[key]
    if (typeof value === 'string') edit[key] = value
  }
  if (body.models !== undefined) edit.models = cleanModelIds(body.models)
  return edit
}

/**
 * Provider list plus the catalogue of the provider in use, for the phone
 * picker — the open session's, or the default when no session is open.
 */
async function modelsPayload(sessionId: string | null = null): Promise<{
  provider: string
  model: string
  defaultProvider: string
  defaultModel: string
  lastUsed: ProviderSelection | null
  providers: {
    id: string; label: string; available: boolean; custom: boolean; models: string[]; listed: string[]
    kind: string; baseURL: string; hasKey: boolean; defaultModel: string
  }[]
  rotation: RotationEntryStatus[]
  rotationEnabled: boolean
  rotationGroups: RotationGroup[]
  rotationGroup: string | null
}> {
  const known = sessionId !== null && loadSessionMessages(sessionId) !== null ? sessionId : null
  const status = getStatus(known)
  const catalogue = status.provider === ROTATE_PROVIDER ? null : await listModels(status.provider)
  const providers = listProviders().map((entry) => ({
    id: entry.id,
    label: entry.label,
    available: entry.credentialAvailable,
    custom: entry.id.startsWith('custom:'),
    models: entry.id === status.provider ? (catalogue?.models ?? []) : [],
    listed: entry.models ?? [],
    kind: entry.kind ?? 'openai',
    baseURL: entry.baseURL ?? '',
    hasKey: entry.hasKey === true,
    defaultModel: entry.defaultModel
  }))
  const selected = getStatus(known)
  return {
    provider: selected.provider,
    model: selected.model,
    defaultProvider: selected.defaultProvider,
    defaultModel: selected.defaultModel,
    lastUsed: selected.lastUsed,
    providers,
    rotation: selected.rotation,
    rotationEnabled: selected.rotationEnabled,
    rotationGroups: selected.rotationGroups,
    rotationGroup: selected.rotationGroup
  }
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
  steered: boolean
}> {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (prompt === '' || prompt.length > 200_000) throw new Error('Enter a prompt of at most 200,000 characters')

  let sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (sessionId !== '' && loadSessionMessages(sessionId) === null) throw new Error('Unknown session')
  // The session's own model decides, or the default for one not made yet.
  const status = getStatus(sessionId === '' ? null : sessionId)
  if (!status.providerReady) throw new Error(status.blockedReason ?? 'Provider is not ready')
  if (sessionId === '') sessionId = createPhoneSession(body).sessionId
  const ids = Array.isArray(body.attachmentIds)
    ? body.attachmentIds.filter((id): id is string => typeof id === 'string')
    : []
  const result = await submitPrompt({ sessionId, runId: randomUUID(), prompt, attachmentIds: ids }, approvals)
  return { sessionId, ...result }
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
  const send = (event: StreamEvent): void => {
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

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip'
}

/** Streams a file inline — for looking at, not for saving. */
function sendFile(res: http.ServerResponse, target: string): void {
  const info = statSync(target)
  if (!info.isFile()) throw new Error('Not a file')
  const extension = path.extname(target).toLowerCase()
  res.writeHead(200, {
    'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
    // A picture drawn in an <img> never runs; an SVG opened on its own would,
    // on the page's origin, with the pairing token beside it.
    ...(extension === '.svg' ? { 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" } : {})
  })
  createReadStream(target).pipe(res)
}

/**
 * An attached file, by the absolute path its card names. Only paths the
 * session's own history names are served — the allowlist is the transcript,
 * not the filesystem.
 */
function attachmentPath(sessionId: string, target: string): string {
  const known = (loadSessionMessages(sessionId) ?? []).some((message) =>
    message.blocks.some((block) => block.type === 'attachment' && block.attachment.path === target)
  )
  if (!known) throw new Error('Not an attachment of this session')
  return target
}

/** A produced file, resolved inside the session's folder so nothing outside it is reachable. */
function producedPath(sessionId: string, relativePath: string): string {
  // antichat's documents live in its own folder, not a project's.
  const root = sessionFileRoot(sessionId)
  if (root === null) throw new Error('This session has no project folder')
  return resolveInWorkspace(root, relativePath)
}

/** Hands a produced file to the phone as a download. */
function sendDownload(res: http.ServerResponse, sessionId: string, relativePath: string): void {
  const target = producedPath(sessionId, relativePath)
  const info = statSync(target)
  if (!info.isFile()) throw new Error('Not a file')

  const name = path.basename(target)
  res.writeHead(200, {
    'content-type': MIME_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    // The quoted name is ASCII-folded; filename* carries the real one.
    'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`
  })
  createReadStream(target).pipe(res)
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

function workspaceBusy(root: string): boolean {
  return listActiveRuns().some((run) => {
    const other = sessionWorkspaceRoot(run.sessionId)
    if (other === null) return false
    const overlaps = (a: string, b: string): boolean => {
      const relative = path.relative(a, b)
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    }
    return overlaps(root, other) || overlaps(other, root)
  })
}

function writeWorkspaceFile(sessionId: string, relativePath: string, content: string, version: string | null): unknown {
  const root = sessionWorkspaceRoot(sessionId)
  if (root === null) throw new Error('This session has no project folder')
  const target = resolveInWorkspace(root, relativePath)
  if (workspaceBusy(root)) throw new Error('Wait for the agent to finish before editing files')
  if (Buffer.byteLength(content) > 2 * 1024 * 1024 || statSync(target).size > 2 * 1024 * 1024) throw new Error('File too large for the editor (limit 2 MB)')
  // The version check and write form one main-process operation. Awaiting in
  // between let two phones both accept the same version and overwrite each other.
  const current = readFileSync(target, 'utf8')
  if (current.includes('\0') || content.includes('\0')) throw new Error('Binary files cannot be edited as text')
  if (version === null || createHash('sha256').update(current).digest('hex') !== version) throw new Error('File changed since it was opened. Reload it before saving.')
  writeFileSync(target, content, 'utf8')
  return { ok: true, path: relativePath, bytes: Buffer.byteLength(content), version: createHash('sha256').update(content).digest('hex') }
}

function runGit(sessionId: string, action: string, message: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const root = sessionWorkspaceRoot(sessionId)
    if (root === null) {
      reject(new Error('This session has no project folder'))
      return
    }
    if (action !== 'status' && workspaceBusy(root)) {
      reject(new Error('Wait for the agent to finish before changing git state'))
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
