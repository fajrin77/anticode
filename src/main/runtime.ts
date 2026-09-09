import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { cancelSessionRuns, runForSession, hasRuns } from './runs'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { loadPersistedSettings, savePersistedSettings } from './settings'
import type { ContentBlock, Message } from './providers/types'
import type { SnapshotMessage } from '@shared/ipc'
import type {
  ModelCatalogue,
  ProviderId,
  ProviderSelection,
  SessionMode,
  SessionSpec,
  SessionStatus
} from '@shared/ipc'
import { AgentSession } from './agent/loop'
import { createProvider, listProviders } from './providers'
import { fetchModels } from './providers/models'
import { ApprovalPolicy } from './approval/policy'
import type { ApprovalGate } from './approval/types'

export const policy = new ApprovalPolicy()

/** Above this, a catalogue is a marketplace rather than an account's own list. */
const AUTO_PICK_LIMIT = 25

interface LiveSession {
  spec: SessionSpec
  agent: AgentSession | null
  messages: Message[]
  selection?: ProviderSelection
}

let workspaceRoot: string | null = null
let selection: ProviderSelection | null = null
const sessions = new Map<string, LiveSession>()
const catalogues = new Map<ProviderId, ModelCatalogue>()

/**
 * Resolved lazily, not at module load: this module is imported before
 * `loadEnvFile()` runs, so reading credentials any earlier sees an empty
 * environment and falls back to the wrong provider.
 */
function current(): ProviderSelection {
  if (selection === null) {
    // Credentials alone decide the provider. A missing model name is not a
    // reason to skip it — the catalogue fills that in a moment later.
    const providers = listProviders()
    const chosen =
      providers.find((p) => p.configured && p.defaultModel !== '') ??
      providers.find((p) => p.configured) ??
      providers.find((p) => p.credentialAvailable)
    selection = { provider: chosen?.id ?? 'clinepass', model: chosen?.defaultModel ?? '' }
  }
  return selection
}

export function setWorkspaceRoot(root: string): void {
  workspaceRoot = root
}

/**
 * Restores what the user left behind: the approval mode and the last
 * provider/model, guarded against providers whose credentials have since
 * disappeared. Called once after the env file is loaded.
 */
export function initPersistedState(): void {
  try {
    const saved = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'sessions.json'), 'utf8')) as { spec: SessionSpec; messages: Message[] }[]
    if (Array.isArray(saved)) for (const entry of saved) {
      if (typeof entry?.spec?.sessionId !== 'string' || !['code', 'chat'].includes(entry.spec.mode) ||
          !(entry.spec.workspaceRoot === null || typeof entry.spec.workspaceRoot === 'string') ||
          !Array.isArray(entry.messages) || !entry.messages.every((message) =>
            ['user', 'assistant'].includes(message.role) && Array.isArray(message.content))) continue
      sessions.set(entry.spec.sessionId, { spec: entry.spec, messages: entry.messages, agent: null })
    }
  } catch { /* First launch or unreadable archive: keep the original file untouched. */ }
  const persisted = loadPersistedSettings()
  if (persisted.autoApprove !== undefined) {
    policy.setAutoApprove(persisted.autoApprove)
  }
  if (persisted.provider !== null && persisted.provider !== undefined) {
    const exists = listProviders().some(
      (p) => p.id === persisted.provider && p.credentialAvailable
    )
    if (exists) {
      selection = { provider: persisted.provider, model: persisted.model ?? '' }
    }
  }
}

/** Drops the active selection so the next current() falls back to built-ins. */
export function resetProviderSelection(): void {
  selection = null
}

/** Switch only between runs; adapters retain the completed conversation. */
export function selectProvider(next: ProviderSelection): void {
  if (!listProviders().some((provider) => provider.id === next.provider && provider.credentialAvailable)) {
    throw new Error('Provider unavailable. Configure its credentials first.')
  }
  if (hasRuns()) throw new Error('Wait for running sessions to finish before changing provider or model.')
  const model = next.model.trim()
  selection = {
    provider: next.provider,
    // Fall back to whatever the catalogue offers so switching provider never
    // lands on an empty model box the user has to fill in by hand.
    model: model !== '' ? model : ((catalogues.get(next.provider)?.models.length ?? 0) <= AUTO_PICK_LIMIT ? catalogues.get(next.provider)?.models[0] ?? '' : '')
  }

  savePersistedSettings({ provider: selection.provider, model: selection.model })
}

/** The cached catalogue without any network round-trip; null when cold. */
export function cachedCatalogue(provider: ProviderId): string[] | null {
  return catalogues.get(provider)?.models ?? null
}

export async function listModels(provider: ProviderId, refresh = false): Promise<ModelCatalogue> {
  const cached = catalogues.get(provider)
  if (cached && !refresh) return cached
  let catalogue: ModelCatalogue
  try {
    catalogue = { provider, models: (await fetchModels(provider)).sort(), error: null }
  } catch (error) {
    catalogue = { provider, models: [], error: (error as Error).message }
  }
  catalogues.set(provider, catalogue)

  // A short catalogue is an account's own model list, so its first entry is a
  // sane automatic pick. A long one is a marketplace of hundreds — choosing
  // alphabetically there lands on an arbitrary paid model, so the user picks.
  const active = current()
  const autoPick = catalogue.models.length <= AUTO_PICK_LIMIT ? catalogue.models[0] : undefined
  if (active.provider === provider && active.model === '' && autoPick !== undefined) {
    selection = { provider, model: autoPick }

    savePersistedSettings({ provider, model: autoPick })
  }
  return catalogue
}

let sessionCreatedSink: ((spec: SessionSpec) => void) | null = null
let sessionClosedSink: ((sessionId: string) => void) | null = null

/** Called once by ipc registration; fans creations out to all windows. */
export function setOnSessionCreated(sink: (spec: SessionSpec) => void): void {
  sessionCreatedSink = sink
}

/** Called once by ipc registration; fans deletions (from the phone) out. */
export function setOnSessionClosed(sink: (sessionId: string) => void): void {
  sessionClosedSink = sink
}

export function createSession(spec: SessionSpec): void {
  const previous = sessions.get(spec.sessionId)
  if (previous && (runForSession(spec.sessionId) !== null || (previous.agent?.messageCount ?? previous.messages.length) > 0)) {
    if (previous.spec.mode === spec.mode && previous.spec.workspaceRoot === spec.workspaceRoot) return
    throw new Error('An existing conversation cannot be rebound to another folder')
  }
  sessions.set(spec.sessionId, { spec, agent: null, messages: [] })
  persistSessions()
  sessionCreatedSink?.(spec)
}

/** Closing a desktop tab only archives it, so this stays silent. */
export function closeSession(sessionId: string): void {
  deleteSession(sessionId)
}

/** A hard delete (phone-initiated): the session is gone everywhere. */
export function deleteSession(sessionId: string): void {
  cancelSessionRuns(sessionId)
  sessions.get(sessionId)?.agent?.dispose()
  sessions.delete(sessionId)
  persistSessions()
  sessionClosedSink?.(sessionId)
}

export function getStatus(): SessionStatus {
  const active = current()
  const info = listProviders().find((p) => p.id === active.provider)

  // The path must match what loadEnvFile() actually reads, or the hint lies.
  const envFile = app.isPackaged
    ? `${app.getPath('userData')}/.env`
    : './.env'
  const blockedReason =
    info?.credentialAvailable !== true
      ? `${info?.credentialHint ?? 'Credentials'} not set — fill in ${envFile} and restart the app`
      : active.model === ''
        ? 'No model selected for this provider'
        : null

  return {
    workspaceRoot,
    provider: active.provider,
    model: active.model,
    autoApprove: policy.isAutoApprove(),
    providerReady: blockedReason === null,
    blockedReason
  }
}

export function getSession(sessionId: string, gate: ApprovalGate): AgentSession {
  const live = sessions.get(sessionId)
  if (!live) throw new Error('Unknown session; reopen this tab')

  if (live.spec.mode === 'code' && live.spec.workspaceRoot === null) {
    throw new Error('A code session needs a project folder')
  }

  const active = current()
  if (!live.agent || live.selection?.provider !== active.provider || live.selection?.model !== active.model) {
    const history = live.agent?.snapshot().messages ?? live.messages
    live.agent = new AgentSession(
      createProvider(active.provider, active.model),
      gate,
      live.spec.mode,
      live.spec.workspaceRoot,
      history,
      live.spec.sessionId
    )
    live.selection = { ...active }
  }
  return live.agent
}

export function providerIds(): ProviderId[] {
  return listProviders().map((p) => p.id)
}

export interface SessionSummary {
  id: string
  title: string
  mode: SessionMode
  workspaceRoot: string | null
  messageCount: number
  /** True while a run (desktop or phone) is executing in this session. */
  running: boolean
}

/** Injected by ipc registration so summaries can flag live runs. */
let runningProbe: ((sessionId: string) => boolean) | null = null

export function setRunningProbe(probe: (sessionId: string) => boolean): void {
  runningProbe = probe
}

export function listSessionSummaries(): SessionSummary[] {
  return [...sessions.values()].map((live) => ({
    id: live.spec.sessionId,
    title: live.spec.mode === 'code' && live.spec.workspaceRoot ? path.basename(live.spec.workspaceRoot) : live.agent?.title ?? live.messages.find((message) => message.role === 'user')?.content.find((block) => block.type === 'text')?.text.slice(0, 60) ?? 'New session',
    mode: live.spec.mode,
    workspaceRoot: live.spec.workspaceRoot,
    messageCount: live.agent?.messageCount ?? live.messages.length,
    running: runningProbe?.(live.spec.sessionId) ?? false
  }))
}

function toSnapshot(messages: Message[]): SnapshotMessage[] {
  return messages.map((message) => ({
    role: message.role,
    blocks: message.content
      .filter(
        (block): block is Extract<ContentBlock, { type: 'text' | 'tool_use' | 'tool_result' }> =>
          block.type === 'text' || block.type === 'tool_use' || block.type === 'tool_result'
      )
      .map((block) => {
        if (block.type === 'text') return { type: 'text' as const, text: block.text }
        if (block.type === 'tool_use') {
          return { type: 'tool_use' as const, id: block.id, name: block.name, input: block.input }
        }
        return {
          type: 'tool_result' as const,
          toolUseId: block.toolUseId,
          content: block.content,
          isError: block.isError
        }
      })
  }))
}

export function loadSessionMessages(sessionId: string): SnapshotMessage[] | null {
  const live = sessions.get(sessionId)
  if (live === undefined) return null
  return toSnapshot(live.agent?.snapshot().messages ?? live.messages)
}

export function sessionWorkspaceRoot(sessionId: string): string | null {
  return sessions.get(sessionId)?.spec.workspaceRoot ?? null
}

/** Direct session creation for remote clients (no renderer round-trip). */
export function createRemoteSession(mode: SessionMode, workspaceRoot: string | null): string {
  const sessionId = randomUUID()
  createSession({ sessionId, mode, workspaceRoot })
  return sessionId
}

/** Atomic snapshots at turn completion and shutdown; never save credentials here. */
export function persistSessions(): void {
  const directory = app.getPath('userData')
  const target = path.join(directory, 'sessions.json')
  const data = [...sessions.values()].map((live) => ({ spec: live.spec, messages: live.agent?.snapshot().messages ?? live.messages }))
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(`${target}.tmp`, JSON.stringify(data), { mode: 0o600 })
    renameSync(`${target}.tmp`, target)
  } catch (error) { console.error('Could not save session history:', (error as Error).message) }
}
export function listSessionSpecs(): SessionSpec[] { return [...sessions.values()].map((live) => live.spec) }
