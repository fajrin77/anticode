import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { cancelSessionRuns, clearPause, runForSession } from './runs'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { loadPersistedSettings, savePersistedSettings } from './settings'
import type { ContentBlock, Message } from './providers/types'
import type { RunSummary, SnapshotMessage } from '@shared/ipc'
import { ROTATE_PROVIDER, SESSION_COLOURS } from '@shared/ipc'
import type {
  ModelCatalogue,
  ModelChoice,
  ProviderId,
  ProviderSelection,
  RotationEntry,
  RotationEntryStatus,
  SessionMode,
  SessionSpec,
  SessionStatus
} from '@shared/ipc'
import { AgentSession, titleOf } from './agent/loop'
import type { ProviderFallback } from './agent/loop'
import type { LLMProvider } from './providers/types'
import { clearWeb, restoreWeb, webRecord } from './web'
import { createProvider, listProviders } from './providers'
import { fetchModels } from './providers/models'
import {
  coolDown,
  coolingUntil,
  countedProvider,
  forgetRotationProvider,
  rankRotation,
  rotationEnabled,
  rotationEntries,
  rotationKey,
  rotationUsage,
  setRotationEnabled,
  setRotationEntries
} from './rotation'
import { ApprovalPolicy } from './approval/policy'
import type { ApprovalGate } from './approval/types'

export const policy = new ApprovalPolicy()

/** Above this, a catalogue is a marketplace rather than an account's own list. */
const AUTO_PICK_LIMIT = 25

/**
 * A rotating session stays on one model for this many prompts before moving
 * on: a follow-up usually builds on the answer before it, and answering it
 * with a different model every time reads like a new conversation.
 */
export const PROMPTS_PER_MODEL = 2

interface LiveSession {
  spec: SessionSpec
  agent: AgentSession | null
  messages: Message[]
  /**
   * The model this session was given. Unset means it still follows the
   * default; it is pinned to that default the moment the default changes, so
   * a pick made in another tab never moves it.
   */
  choice?: ProviderSelection
  /** What the agent is actually talking to — under rotation, this run's entry. */
  selection?: ProviderSelection
  /** Rotation only: prompts sent to `selection` since the session moved onto it. */
  promptsOnEntry?: number
  /** One entry per finished assistant turn, oldest first. */
  summaries: RunSummary[]
}

let workspaceRoot: string | null = null
let selection: ProviderSelection | null = null
const sessions = new Map<string, LiveSession>()
const catalogues = new Map<ProviderId, ModelCatalogue>()
/** Next badge colour, round-robin, so fresh sessions tell apart at a glance. */
let nextColour = 0

function validColour(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < SESSION_COLOURS.length
}

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
    const saved = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'sessions.json'), 'utf8')) as { spec: SessionSpec; messages: Message[]; summaries?: RunSummary[]; web?: unknown; choice?: unknown }[]
    if (Array.isArray(saved)) for (const entry of saved) {
      if (typeof entry?.spec?.sessionId !== 'string' || !['code', 'chat'].includes(entry.spec.mode) ||
          !(entry.spec.workspaceRoot === null || typeof entry.spec.workspaceRoot === 'string') ||
          !Array.isArray(entry.messages) || !entry.messages.every((message) =>
            ['user', 'assistant'].includes(message.role) && Array.isArray(message.content))) continue
      const choice = entry.choice as ProviderSelection | undefined
      sessions.set(entry.spec.sessionId, {
        spec: entry.spec,
        messages: entry.messages,
        agent: null,
        summaries: Array.isArray(entry.summaries) ? entry.summaries : [],
        ...(typeof choice?.provider === 'string' && typeof choice.model === 'string'
          ? { choice: { provider: choice.provider, model: choice.model } }
          : {})
      })
      // The page this session had open comes back with it, so relaunching the
      // app lands on the same local server the last run was looking at.
      restoreWeb(entry.spec.sessionId, entry.web)
      if (validColour(entry.spec.colour)) nextColour = (entry.spec.colour + 1) % SESSION_COLOURS.length
    }
  } catch { /* First launch or unreadable archive: keep the original file untouched. */ }
  const persisted = loadPersistedSettings()
  if (persisted.autoApprove !== undefined) {
    policy.setAutoApprove(persisted.autoApprove)
  }
  if (persisted.provider !== null && persisted.provider !== undefined) {
    const exists = persisted.provider === ROTATE_PROVIDER
      ? rotationEnabled() && rotationEntries().length > 0
      : listProviders().some((p) => p.id === persisted.provider && p.credentialAvailable)
    if (exists) {
      selection = { provider: persisted.provider, model: persisted.provider === ROTATE_PROVIDER ? '' : (persisted.model ?? '') }
    }
  }
}

/**
 * A provider is gone: sessions on it go back to following the default, and
 * the default itself falls back to built-ins if it was that provider.
 */
export function forgetProvider(provider: ProviderId): void {
  forgetRotationProvider(provider)
  let changed = false
  for (const live of sessions.values()) {
    if (live.choice?.provider === provider) {
      delete live.choice
      changed = true
    }
  }
  if (current().provider === provider) selection = null
  if (changed) persistSessions()
}

/**
 * Every session still following the default takes it as its own, so the
 * default can change without dragging any existing session along with it.
 */
function pinSessions(): void {
  const active = current()
  let changed = false
  for (const live of sessions.values()) {
    if (live.choice !== undefined) continue
    live.choice = { ...active }
    changed = true
  }
  if (changed) persistSessions()
}

function choiceOf(live: LiveSession): ProviderSelection {
  return live.choice ?? current()
}

/**
 * The model a provider starts on when none was named: the first id the user
 * listed for it in Settings, else the head of a short catalogue.
 */
function autoPickFor(provider: ProviderId, models: string[]): string {
  const listed = listProviders().find((entry) => entry.id === provider)?.defaultModel ?? ''
  if (listed !== '') return listed
  return models.length <= AUTO_PICK_LIMIT ? (models[0] ?? '') : ''
}

/**
 * A model picked in a session is that session's alone: every other session
 * keeps the one it has, and a run already going in this one keeps its model
 * until it ends (getSession never swaps a working session's provider). The
 * pick also becomes the default new sessions start on — with no session id,
 * that is all it changes.
 */
export function selectProvider(next: ProviderSelection, sessionId?: string | null): void {
  const live = sessionId === null || sessionId === undefined ? undefined : sessions.get(sessionId)
  if (sessionId !== null && sessionId !== undefined && live === undefined) throw new Error('Unknown session; reopen this tab')
  let chosen: ProviderSelection
  if (next.provider === ROTATE_PROVIDER) {
    if (!rotationEnabled()) throw new Error('Rotate usage is off — turn it on in Settings → Providers')
    if (rotationEntries().length === 0) throw new Error('Rotate usage has no models yet — add them in Settings → Providers')
    chosen = { provider: ROTATE_PROVIDER, model: '' }
  } else {
    if (!listProviders().some((provider) => provider.id === next.provider && provider.credentialAvailable)) {
      throw new Error('Provider unavailable. Configure its credentials first.')
    }
    const model = next.model.trim()
    chosen = {
      provider: next.provider,
      // Fall back to whatever the catalogue offers so switching provider never
      // lands on an empty model box the user has to fill in by hand.
      model: model !== '' ? model : autoPickFor(next.provider, catalogues.get(next.provider)?.models ?? [])
    }
  }

  pinSessions()
  if (live !== undefined) {
    live.choice = chosen
    // Picking Rotate again starts a fresh turn on the pool.
    delete live.promptsOnEntry
    persistSessions()
  }
  selection = chosen
  savePersistedSettings({ provider: chosen.provider, model: chosen.model })
}

/** True while a working session is talking to this provider. */
export function providerInUse(provider: ProviderId): boolean {
  for (const [sessionId, live] of sessions) {
    if (live.selection?.provider === provider && runForSession(sessionId) !== null) return true
  }
  return false
}

/** Replaces the Rotate usage pool; sessions set to rotate use it from their next prompt. */
export function applyRotation(entries: RotationEntry[]): void {
  setRotationEntries(entries)
  // An emptied pool leaves nothing to rotate over. Sessions set to rotate say
  // so in their composer; the default goes back to a plain model.
  if (rotationEntries().length === 0 && current().provider === ROTATE_PROVIDER) {
    selection = null
    savePersistedSettings({ provider: current().provider, model: current().model })
  }
}

/**
 * Rotate usage switched on or off. Off, nothing may be left on Rotate: each
 * session on it keeps the model its last prompt went to (or the default,
 * before it sent one), and the default goes back to a plain model.
 */
export function applyRotationEnabled(on: boolean): void {
  setRotationEnabled(on)
  if (on) return
  if (current().provider === ROTATE_PROVIDER) {
    selection = null
    savePersistedSettings({ provider: current().provider, model: current().model })
  }
  let changed = false
  for (const live of sessions.values()) {
    if (live.choice?.provider !== ROTATE_PROVIDER) continue
    live.choice = live.selection !== undefined ? { ...live.selection } : { ...current() }
    delete live.promptsOnEntry
    changed = true
  }
  if (changed) persistSessions()
}

/** A provider's model list changed in Settings; the next listModels refetches. */
export function forgetCatalogue(provider: ProviderId): void {
  catalogues.delete(provider)
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
  const autoPick = autoPickFor(provider, catalogue.models)
  if (autoPick === '') return catalogue
  if (active.provider === provider && active.model === '') {
    selection = { provider, model: autoPick }

    savePersistedSettings({ provider, model: autoPick })
  }
  // A session pinned before the catalogue arrived took the empty model too.
  let filled = false
  for (const live of sessions.values()) {
    if (live.choice?.provider !== provider || live.choice.model !== '') continue
    live.choice = { provider, model: autoPick }
    filled = true
  }
  if (filled) persistSessions()
  return catalogue
}

let sessionCreatedSink: ((spec: SessionSpec) => void) | null = null
let sessionClosedSink: ((sessionId: string) => void) | null = null
let sessionTitledSink: ((sessionId: string, title: string) => void) | null = null
/** The name each session was last announced under, so a rename is told once. */
const announcedTitles = new Map<string, string>()

/** Called once by ipc registration; fans creations out to all windows. */
export function setOnSessionCreated(sink: (spec: SessionSpec) => void): void {
  sessionCreatedSink = sink
}

/** Called once by ipc registration; fans renames out to every viewer. */
export function setOnSessionTitled(sink: (sessionId: string, title: string) => void): void {
  sessionTitledSink = sink
}

/**
 * A session's name is decided here, never by a viewer: an anticode session is
 * its folder, an antichat one what the user typed first. The desktop and the
 * phone both show this, whichever of them the prompt came from.
 */
function titleFor(live: LiveSession): string {
  if (live.spec.mode === 'code' && live.spec.workspaceRoot) return path.basename(live.spec.workspaceRoot)
  return live.agent?.title ?? titleOf(live.messages)
}

function specOf(live: LiveSession): SessionSpec {
  return { ...live.spec, title: titleFor(live) }
}

/**
 * Tells every viewer the session's current name if it changed — called once a
 * prompt is in its history, and after a turn is taken back out of it.
 */
export function announceTitle(sessionId: string): void {
  const live = sessions.get(sessionId)
  if (live === undefined) return
  const title = titleFor(live)
  if (announcedTitles.get(sessionId) === title) return
  announcedTitles.set(sessionId, title)
  sessionTitledSink?.(sessionId, title)
}

/** Called once by ipc registration; fans deletions (from the phone) out. */
export function setOnSessionClosed(sink: (sessionId: string) => void): void {
  sessionClosedSink = sink
}

export function createSession(spec: SessionSpec): SessionSpec {
  const previous = sessions.get(spec.sessionId)
  if (previous && (runForSession(spec.sessionId) !== null || (previous.agent?.messageCount ?? previous.messages.length) > 0)) {
    if (previous.spec.mode === spec.mode && previous.spec.workspaceRoot === spec.workspaceRoot) return specOf(previous)
    throw new Error('An existing conversation cannot be rebound to another folder')
  }
  // A session keeps its colour through a rebind; a new one takes the colour
  // its creator proposed, or the next one round.
  const kept = previous?.spec.colour
  const colour = validColour(kept) ? kept : validColour(spec.colour) ? spec.colour : nextColour
  if (!validColour(kept)) nextColour = (colour + 1) % SESSION_COLOURS.length
  const settled: SessionSpec = {
    sessionId: spec.sessionId,
    mode: spec.mode,
    workspaceRoot: spec.workspaceRoot,
    colour
  }
  const live: LiveSession = {
    spec: settled,
    agent: null,
    messages: [],
    summaries: [],
    // A draft rebound to its folder on first send keeps the model it was given.
    ...(previous?.choice !== undefined ? { choice: previous.choice } : {})
  }
  sessions.set(spec.sessionId, live)
  persistSessions()
  const announced = specOf(live)
  announcedTitles.set(spec.sessionId, announced.title ?? '')
  sessionCreatedSink?.(announced)
  return announced
}

/**
 * Sessions saved before colours lived here have none; the desktop still shows
 * the one it picked back then, and hands it over so the phone can match it.
 */
export function adoptSessionColour(sessionId: string, colour: number): void {
  const live = sessions.get(sessionId)
  if (live === undefined || validColour(live.spec.colour) || !validColour(colour)) return
  live.spec = { ...live.spec, colour }
  persistSessions()
}

/** Closing a desktop tab only archives it, so this stays silent. */
export function closeSession(sessionId: string): void {
  deleteSession(sessionId)
}

/** A hard delete (phone-initiated): the session is gone everywhere. */
export function deleteSession(sessionId: string): void {
  cancelSessionRuns(sessionId)
  clearPause(sessionId)
  const live = sessions.get(sessionId)
  live?.agent?.dispose()
  // antichat's folder holds only copies it was sent and files it made for
  // this conversation; they go with it. A project folder is never touched.
  const own = live?.spec.mode === 'chat' ? chatFilesRoot(sessionId) : null
  if (own !== null) void rm(own, { recursive: true, force: true }).catch(() => undefined)
  sessions.delete(sessionId)
  announcedTitles.delete(sessionId)
  clearWeb(sessionId)
  persistSessions()
  sessionClosedSink?.(sessionId)
}

type Providers = ReturnType<typeof listProviders>

function entryReady(entry: RotationEntry, providers: Providers): boolean {
  return providers.some((provider) => provider.id === entry.provider && provider.credentialAvailable)
}

function readiness(
  choice: ProviderSelection,
  providers: Providers
): { providerReady: boolean; blockedReason: string | null } {
  let blockedReason: string | null
  if (choice.provider === ROTATE_PROVIDER) {
    const pool = rotationEntries()
    blockedReason =
      !rotationEnabled()
        ? 'Rotate usage is off — turn it on in Settings → Providers, or pick a model'
        : pool.length === 0
          ? 'Rotate usage has no models yet — add them in Settings → Providers'
          : !pool.some((entry) => entryReady(entry, providers))
            ? 'No model in Rotate usage is ready — check their providers in Settings → Providers'
            : null
  } else {
    const info = providers.find((p) => p.id === choice.provider)
    // Every provider's credentials can be set in Settings now, so that is where
    // the hint points — the env file still works, but it is not the only way.
    blockedReason =
      info === undefined
        ? 'No provider set up — add one in Settings → Providers'
        : !info.credentialAvailable
          ? `${info.label} has no ${info.credentialHint} yet — add it in Settings → Providers`
          : choice.model === ''
            ? 'No model selected — choose one in Settings → Models'
            : null
  }
  return { providerReady: blockedReason === null, blockedReason }
}

function choiceStatus(live: LiveSession, providers: Providers): ModelChoice {
  const choice = choiceOf(live)
  return {
    ...choice,
    ...readiness(choice, providers),
    lastUsed: choice.provider === ROTATE_PROVIDER && live.selection !== undefined ? { ...live.selection } : null
  }
}

function rotationStatus(providers: Providers): RotationEntryStatus[] {
  return rotationEntries().map((entry) => ({
    ...entry,
    ...rotationUsage(entry),
    label: providers.find((provider) => provider.id === entry.provider)?.label ?? entry.provider,
    ready: entryReady(entry, providers),
    coolingUntil: coolingUntil(entry)
  }))
}

/**
 * The default model at the top — what a new session starts on — and every
 * session's own model under `sessions`. With a session id, the top half is
 * that session's model instead, for callers about to prompt it.
 */
export function getStatus(sessionId?: string | null): SessionStatus {
  const providers = listProviders()
  const own = sessionId === null || sessionId === undefined ? undefined : sessions.get(sessionId)
  const top = own !== undefined ? choiceStatus(own, providers) : { ...current(), ...readiness(current(), providers), lastUsed: null }
  return {
    workspaceRoot,
    provider: top.provider,
    model: top.model,
    autoApprove: policy.isAutoApprove(),
    providerReady: top.providerReady,
    blockedReason: top.blockedReason,
    lastUsed: top.lastUsed,
    sessions: Object.fromEntries([...sessions].map(([id, live]) => [id, choiceStatus(live, providers)])),
    rotation: rotationStatus(providers),
    rotationEnabled: rotationEnabled()
  }
}

/** Every session talks through this, so pooled models count what they spend. */
function providerFor(target: ProviderSelection): LLMProvider {
  return countedProvider(target, createProvider(target.provider, target.model))
}

/** Sessions working on this pool entry right now. */
function busyOn(entry: RotationEntry): number {
  const key = rotationKey(entry)
  let count = 0
  for (const [id, live] of sessions) {
    if (live.selection !== undefined && rotationKey(live.selection) === key && runForSession(id) !== null) count += 1
  }
  return count
}

export function getSession(sessionId: string, gate: ApprovalGate): AgentSession {
  const live = sessions.get(sessionId)
  if (!live) throw new Error('Unknown session; reopen this tab')

  if (live.spec.mode === 'code' && live.spec.workspaceRoot === null) {
    throw new Error('A code session needs a project folder')
  }

  // A session that is working keeps the agent it is working with: a follow-up
  // joins that run, and swapping its provider would strand the run. A model
  // picked meanwhile takes over from this session's next prompt.
  if (live.agent !== null && runForSession(sessionId) !== null) return live.agent

  const choice = choiceOf(live)
  let target: ProviderSelection
  let fallback: ProviderFallback | null = null
  if (choice.provider === ROTATE_PROVIDER) {
    // The session stays on its model for PROMPTS_PER_MODEL prompts, then
    // moves to the pool entry with the least load other than the one it
    // leaves. One that fails mid-run rests for a while and hands the turn on.
    const providers = listProviders()
    if (!rotationEnabled()) throw new Error(readiness(choice, providers).blockedReason ?? 'Rotate usage is off')
    const ready = (entry: RotationEntry): boolean => entryReady(entry, providers)
    const tried = new Set<string>()
    const next = (): RotationEntry | undefined => rankRotation({ ready, busy: busyOn, exclude: tried })[0]
    const current = live.selection
    const pool = rotationEntries()
    const staying =
      current !== undefined &&
      (live.promptsOnEntry ?? 0) > 0 &&
      (live.promptsOnEntry ?? 0) < PROMPTS_PER_MODEL &&
      pool.some((entry) => rotationKey(entry) === rotationKey(current)) &&
      ready(current) &&
      coolingUntil(current) === null
    let first: RotationEntry | undefined
    if (staying) {
      first = current
      live.promptsOnEntry = (live.promptsOnEntry ?? 0) + 1
    } else {
      // Its turn is up: someone else goes next, unless nobody else can.
      if (current !== undefined && live.promptsOnEntry !== undefined) tried.add(rotationKey(current))
      first = next()
      // A model that is resting is no better than the healthy one it would
      // replace; the session starts another turn where it is instead.
      const healthy =
        current !== undefined && pool.some((entry) => rotationKey(entry) === rotationKey(current)) &&
        ready(current) && coolingUntil(current) === null
      if (healthy && (first === undefined || coolingUntil(first) !== null)) first = current
      if (first === undefined) {
        tried.clear()
        first = next()
      }
      live.promptsOnEntry = 1
    }
    if (first === undefined) throw new Error(readiness(choice, providers).blockedReason ?? 'No model in Rotate usage is ready')
    tried.add(rotationKey(first))
    target = first
    fallback = () => {
      if (live.selection !== undefined) coolDown(live.selection)
      const following = next()
      if (following === undefined) return null
      tried.add(rotationKey(following))
      live.selection = { ...following }
      // The model that took over starts its own turn with this prompt.
      live.promptsOnEntry = 1
      return providerFor(following)
    }
  } else {
    target = choice
  }

  const provider = providerFor(target)
  if (live.agent === null) {
    live.agent = new AgentSession(
      provider,
      gate,
      live.spec.mode,
      sessionFileRoot(sessionId),
      live.messages,
      live.spec.sessionId
    )
  }
  live.agent.useProvider(provider, fallback)
  live.selection = { provider: target.provider, model: target.model }
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
  /** Index into SESSION_COLOURS, or null until the desktop hands one over. */
  colour: number | null
}

/** Injected by ipc registration so summaries can flag live runs. */
let runningProbe: ((sessionId: string) => boolean) | null = null

export function setRunningProbe(probe: (sessionId: string) => boolean): void {
  runningProbe = probe
}

export function listSessionSummaries(): SessionSummary[] {
  return [...sessions.values()].map((live) => ({
    id: live.spec.sessionId,
    title: titleFor(live),
    mode: live.spec.mode,
    workspaceRoot: live.spec.workspaceRoot,
    messageCount: live.agent?.messageCount ?? live.messages.length,
    running: runningProbe?.(live.spec.sessionId) ?? false,
    colour: validColour(live.spec.colour) ? live.spec.colour : null
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
        if (block.type === 'text') {
          // An attachment header becomes a card rather than a line of prose.
          if (block.attachment !== undefined) {
            return { type: 'attachment' as const, attachment: block.attachment }
          }
          // A follow-up shows as the words that were typed, not the framing
          // the model was given around them.
          if (block.followUp !== undefined) {
            return {
              type: 'text' as const,
              text: block.followUp.text,
              followUp: block.followUp.during ? ('during' as const) : ('after' as const)
            }
          }
          return { type: 'text' as const, text: block.text }
        }
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

/**
 * Undoes the last exchange in a session and returns the prompt that started
 * it, so a wrong prompt can be corrected instead of argued with. The run's
 * summary goes with it — the turn it described no longer exists.
 */
export function revertLastTurn(sessionId: string): string | null {
  const live = sessions.get(sessionId)
  if (live === undefined) return null
  if (runForSession(sessionId) !== null) {
    throw new Error('Pause this session before reverting its last turn')
  }
  // The turn the pause interrupted is gone, and with it anything to resume.
  clearPause(sessionId)
  const reverted = live.agent?.revertLastTurn() ?? null
  if (reverted === null) {
    // No agent yet: the session is still just its stored messages.
    for (let i = live.messages.length - 1; i >= 0; i--) {
      const message = live.messages[i]
      if (message?.role !== 'user') continue
      const text = message.content.find(
        (block) => block.type === 'text' && block.attachment === undefined
      )
      if (text === undefined || text.type !== 'text') continue
      live.messages.length = i
      live.summaries.pop()
      persistSessions()
      announceTitle(sessionId)
      return text.text
    }
    return null
  }
  live.summaries.pop()
  persistSessions()
  // Taking back the first prompt takes its name back with it.
  announceTitle(sessionId)
  return reverted
}

/** Closes a run: appends what it cost, for every viewer of this session. */
export function recordRunSummary(sessionId: string, summary: RunSummary): void {
  sessions.get(sessionId)?.summaries.push(summary)
}

export function loadSessionSummaries(sessionId: string): RunSummary[] {
  return sessions.get(sessionId)?.summaries ?? []
}

export function sessionWorkspaceRoot(sessionId: string): string | null {
  return sessions.get(sessionId)?.spec.workspaceRoot ?? null
}

/**
 * antichat has no project folder, but it still edits the files it is sent.
 * Each conversation gets a private folder in the app's own data for that:
 * attachments are copied in, the tools work there, and what they write is
 * downloaded from there. The id becomes a path segment, so it must be plain.
 */
function chatFilesRoot(sessionId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) return null
  return path.join(app.getPath('userData'), 'antichat', sessionId)
}

/** Where a session's files live: its project folder, or antichat's own. */
export function sessionFileRoot(sessionId: string): string | null {
  const live = sessions.get(sessionId)
  if (live === undefined) return null
  if (live.spec.mode === 'code') return live.spec.workspaceRoot
  const root = chatFilesRoot(sessionId)
  // Made on demand: path checks resolve the real path, so it must exist.
  if (root !== null) mkdirSync(root, { recursive: true })
  return root
}

export function sessionMode(sessionId: string): SessionMode | null {
  return sessions.get(sessionId)?.spec.mode ?? null
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
  const data = [...sessions.values()].map((live) => ({
    spec: live.spec,
    messages: live.agent?.snapshot().messages ?? live.messages,
    summaries: live.summaries,
    web: webRecord(live.spec.sessionId),
    ...(live.choice !== undefined ? { choice: live.choice } : {})
  }))
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(`${target}.tmp`, JSON.stringify(data), { mode: 0o600 })
    renameSync(`${target}.tmp`, target)
  } catch (error) { console.error('Could not save session history:', (error as Error).message) }
}
export function listSessionSpecs(): SessionSpec[] { return [...sessions.values()].map(specOf) }
