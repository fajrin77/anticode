import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { cancelSessionRuns, clearPause, isPaused, isPausedForRetry, restorePausedSession, runForSession } from './runs'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { loadPersistedSettings, savePersistedSettings } from './settings'
import type { ContentBlock, Message } from './providers/types'
import type { AttachmentRef, RunSummary, SnapshotMessage } from '@shared/ipc'
import { INSTRUCTIONS_MAX_CHARS, ROTATE_PROVIDER, SESSION_COLOURS } from '@shared/ipc'
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
import { followUpMode } from './followUp'
import { answeredRuns, isTypedPrompt } from './agent/turns'
import { CheckpointStore } from './checkpoints'
import type { ProviderFallback } from './agent/loop'
import type { LLMProvider } from './providers/types'
import { clearWeb, restoreWeb, webRecord } from './web'
import { createProvider, listProviders } from './providers'
import { fetchModels } from './providers/models'
import {
  activeRotationEntries,
  activeRotationGroupId,
  coolDown,
  coolingUntil,
  countedProvider,
  forgetRotationProvider,
  outOfUsage,
  rankRotation,
  rotationEnabled,
  rotationEntries,
  rotationGroups,
  rotationKey,
  rotationUsage,
  setActiveRotationGroup,
  setRotationEnabled,
  setRotationEntries,
  setRotationGroups
} from './rotation'
import { ApprovalPolicy } from './approval/policy'
import { preferences } from './preferences'
import type { ApprovalGate } from './approval/types'

export const policy = new ApprovalPolicy()

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
/** The explicit provider/model to restore whenever global rotation is off. */
let fallbackSelection: ProviderSelection | null = null
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

/** Used only when no explicit default has ever been saved, or it was removed. */
function firstConnectedSelection(): ProviderSelection {
  const provider = listProviders().find((entry) => entry.credentialAvailable)
  if (provider === undefined) return { provider: 'clinepass', model: '' }
  return {
    provider: provider.id,
    model: chosenFor(provider.id)[0] ?? provider.defaultModel
  }
}

function fallback(): ProviderSelection {
  if (fallbackSelection !== null) return fallbackSelection
  const persisted = loadPersistedSettings()
  const available = listProviders().some(
    (provider) => provider.id === persisted.provider && provider.credentialAvailable
  )
  fallbackSelection = available && persisted.provider !== ROTATE_PROVIDER
    ? { provider: persisted.provider as ProviderId, model: persisted.model ?? '' }
    : firstConnectedSelection()
  return fallbackSelection
}

function saveFallback(next: ProviderSelection): void {
  fallbackSelection = { ...next }
  savePersistedSettings({ provider: next.provider, model: next.model })
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
    const saved = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'sessions.json'), 'utf8')) as { spec: SessionSpec; messages: Message[]; summaries?: RunSummary[]; web?: unknown; choice?: unknown; paused?: boolean; pausedForRetry?: boolean }[]
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
      if (entry.paused === true) restorePausedSession(entry.spec.sessionId, entry.pausedForRetry === true)
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
  if (persisted.alwaysAllowed !== undefined) {
    policy.restoreAlways(persisted.alwaysAllowed)
  }
  fallback()
  selection = rotationEnabled()
    ? { provider: ROTATE_PROVIDER, model: '' }
    : { ...fallback() }
  // Rotate usage is a global mode, not a per-composer selection. Restored
  // sessions and the new-session default must therefore agree immediately.
  if (rotationEnabled()) applyRotationEnabled(true)
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
  if (fallback().provider === provider) {
    fallbackSelection = null
    saveFallback(firstConnectedSelection())
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

/** The models switched on for a provider in Settings → Models, in order. */
function chosenFor(provider: ProviderId): string[] {
  return rotationEntries().filter((entry) => entry.provider === provider).map((entry) => entry.model)
}

/**
 * What a choice amounts to. Only models switched on in Settings → Models are
 * offered, so only those are used: a session left on any other model — a
 * provider's listed default, one switched off since — moves to the first one
 * chosen for its provider, or to none, which asks for a pick. The stored
 * choice is kept, so switching its model back on brings it back.
 */
function effective(choice: ProviderSelection): ProviderSelection {
  if (choice.provider === ROTATE_PROVIDER) return choice
  // When rotation is off, applyRotationEnabled has already chosen the first
  // connected provider and its best known model. It remains usable even when
  // that model is not part of the (currently inactive) rotation pool.
  if (!rotationEnabled()) return choice
  const chosen = chosenFor(choice.provider)
  return chosen.includes(choice.model) ? choice : { provider: choice.provider, model: chosen[0] ?? '' }
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
  if (rotationEnabled() && next.provider !== ROTATE_PROVIDER && live !== undefined) {
    throw new Error('Turn off Rotate usage before choosing a model')
  }
  if (next.provider === ROTATE_PROVIDER) {
    if (!rotationEnabled()) throw new Error('Rotate usage is off — turn it on in Settings → Providers')
    if (activeRotationEntries().length === 0) throw new Error('Rotate usage has no models yet — add them in Settings → Providers')
    chosen = { provider: ROTATE_PROVIDER, model: '' }
  } else {
    const providerInfo = listProviders().find((provider) => provider.id === next.provider && provider.credentialAvailable)
    if (providerInfo === undefined) {
      throw new Error('Provider unavailable. Configure its credentials first.')
    }
    const model = next.model.trim()
    const knownModels = providerInfo.models ?? []
    // A provider that publishes/configures a model list is authoritative.
    // Search text in the composer must not silently turn a typo into the
    // permanent default (unknown ids belong in Settings → Models first).
    if (model !== '' && knownModels.length > 0 &&
        !knownModels.includes(model) && !chosenFor(next.provider).includes(model)) {
      throw new Error(`Unknown model “${model}” for ${providerInfo.label}. Choose a listed model or add the id in Settings → Models.`)
    }
    // Providers without a catalogue still accept a hand-typed id.
    if (model !== '' && !chosenFor(next.provider).includes(model)) {
      setRotationEntries([...rotationEntries(), { provider: next.provider, model }])
    }
    // No model named: the first one chosen for that provider, or none yet.
    chosen = {
      provider: next.provider,
      model: model !== '' ? model : (chosenFor(next.provider)[0] ?? providerInfo.defaultModel)
    }
  }

  // The Providers page may change the saved fallback while rotation stays
  // active. It does not unlock either composer or disturb rotating sessions.
  if (rotationEnabled() && chosen.provider !== ROTATE_PROVIDER) {
    saveFallback(chosen)
    return
  }

  pinSessions()
  if (live !== undefined) {
    live.choice = chosen
    // Picking Rotate again starts a fresh turn on the pool.
    delete live.promptsOnEntry
    persistSessions()
  }
  selection = chosen
  if (chosen.provider !== ROTATE_PROVIDER) saveFallback(chosen)
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
  // While the global mode is on, an empty pool remains visibly Rotate but
  // blocked, so every composer still reflects the setting truthfully.
  if (!rotationEnabled() && rotationEntries().length === 0 && current().provider === ROTATE_PROVIDER) {
    selection = null
    savePersistedSettings({ provider: current().provider, model: current().model })
  }
}

/**
 * A rotating session that is not working lets go of the model it was on, so
 * its next prompt is placed afresh — and its chip stops naming a model the
 * rotation may no longer offer. One that is working keeps its model until its
 * run ends.
 */
function releaseRotatingSessions(): void {
  for (const [sessionId, live] of sessions) {
    if (runForSession(sessionId) === null) delete live.selection
    delete live.promptsOnEntry
  }
}

/** The groups replaced; sessions follow the group in use from their next prompt. */
export function applyRotationGroups(next: unknown[]): void {
  const before = JSON.stringify(activeRotationEntries())
  setRotationGroups(next)
  if (JSON.stringify(activeRotationEntries()) !== before) releaseRotatingSessions()
}

/**
 * Puts a group in use for every session at once, like Rotate usage itself:
 * each composer shows it straight away, and each session's next prompt goes
 * to one of its models.
 */
export function applyRotationGroup(id: string | null): void {
  if (id === activeRotationGroupId()) return
  setActiveRotationGroup(id)
  releaseRotatingSessions()
}

/**
 * Rotate usage is global. On, every existing and future composer follows the
 * pool. Off, every composer falls back to the first connected provider.
 */
export function applyRotationEnabled(on: boolean): void {
  setRotationEnabled(on)
  const chosen = on
    ? { provider: ROTATE_PROVIDER, model: '' }
    : { ...fallback() }
  selection = chosen
  let changed = false
  for (const [sessionId, live] of sessions) {
    if (live.choice?.provider !== chosen.provider || live.choice.model !== chosen.model) changed = true
    live.choice = { ...chosen }
    // Do not replace the provider beneath a run already in progress. Its next
    // prompt follows the newly applied global mode.
    if (runForSession(sessionId) === null) delete live.selection
    delete live.promptsOnEntry
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
  // The catalogue is only what can be chosen in Settings → Models; it never
  // picks a model on its own.
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

/** A session's name as every viewer shows it; '' for one that is gone. */
export function sessionTitle(sessionId: string): string {
  const live = sessions.get(sessionId)
  return live === undefined ? '' : titleFor(live)
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
    colour,
    // A draft given instructions before its first prompt keeps them when bound.
    ...(previous?.spec.instructions !== undefined ? { instructions: previous.spec.instructions } : {})
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
 * Makes a durable branch owned by the main process. A fork retains the
 * transcript through one typed prompt; a duplicate retains everything. The
 * provider choice follows the source, while Rotate chooses a pool entry
 * independently on the branch's first run.
 */
export function cloneSession(
  sourceSessionId: string,
  newSessionId: string,
  throughPrompt: number | null,
  proposedColour?: number
): SessionSpec {
  const source = sessions.get(sourceSessionId)
  if (source === undefined) throw new Error('The conversation to copy no longer exists')
  if (sessions.has(newSessionId)) throw new Error('The new conversation already exists')
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(newSessionId)) throw new Error('Invalid conversation ID')
  if (throughPrompt !== null && (!Number.isInteger(throughPrompt) || throughPrompt < 1)) {
    throw new Error('Choose a prompt to branch from')
  }

  const complete = source.agent?.snapshot().messages ?? structuredClone(source.messages)
  let messages = complete
  if (throughPrompt !== null) {
    let seen = 0
    const boundary = complete.findIndex((message) => isTypedPrompt(message) && ++seen === throughPrompt)
    if (boundary < 0) throw new Error('The prompt to branch from no longer exists')
    messages = complete.slice(0, boundary + 1)
  }
  messages = structuredClone(messages)

  const colour = validColour(proposedColour) ? proposedColour : nextColour
  nextColour = (colour + 1) % SESSION_COLOURS.length
  // Antichat files live under the session id. Give the branch its own copies
  // so editing or deleting either conversation cannot alter the other one.
  if (source.spec.mode === 'chat') {
    const from = chatFilesRoot(sourceSessionId)
    const to = chatFilesRoot(newSessionId)
    if (from === null || to === null) throw new Error('Invalid conversation ID')
    if (existsSync(from)) cpSync(from, to, { recursive: true, errorOnExist: true })
    // Attachment cards persist absolute paths. Point the clone at its copies,
    // otherwise deleting the source conversation would break the branch.
    messages = messages.map((message) => ({
      ...message,
      content: message.content.map((block) => {
        if (block.type !== 'text' || block.attachment === undefined) return block
        const relative = path.relative(from, block.attachment.path)
        const inside = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        return inside
          ? { ...block, attachment: { ...block.attachment, path: path.join(to, relative) } }
          : block
      })
    }))
  }

  const live: LiveSession = {
    spec: {
      ...source.spec,
      sessionId: newSessionId,
      colour
    },
    agent: null,
    messages,
    summaries: structuredClone(source.summaries.slice(0, answeredRuns(messages))),
    ...(source.choice !== undefined ? { choice: { ...source.choice } } : {})
  }

  sessions.set(newSessionId, live)
  persistSessions()
  const announced = specOf(live)
  announcedTitles.set(newSessionId, announced.title ?? '')
  sessionCreatedSink?.(announced)
  return announced
}

/** Instructions for one session; its next request reads them. */
export function setSessionInstructions(sessionId: string, instructions: unknown): SessionSpec {
  const live = sessions.get(sessionId)
  if (live === undefined) throw new Error('Unknown session; reopen this tab')
  if (typeof instructions !== 'string') throw new Error('Expected text')
  if (instructions.length > INSTRUCTIONS_MAX_CHARS) {
    throw new Error(`Keep instructions under ${INSTRUCTIONS_MAX_CHARS.toLocaleString('en-US')} characters`)
  }
  const text = instructions.trim()
  const { instructions: _previous, ...rest } = live.spec
  live.spec = text === '' ? rest : { ...rest, instructions: text }
  persistSessions()
  return specOf(live)
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
  const kept = checkpointDir(sessionId)
  if (kept !== null) void rm(kept, { recursive: true, force: true }).catch(() => undefined)
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
    const pool = activeRotationEntries()
    const group = rotationGroups().find((item) => item.id === activeRotationGroupId())
    const where = group === undefined ? 'Rotate usage' : `The “${group.name}” group`
    blockedReason =
      !rotationEnabled()
        ? 'Rotate usage is off — turn it on in Settings → Providers, or pick a model'
        : pool.length === 0
          ? `${where} has no models yet — add them in Settings → Providers`
          : !pool.some((entry) => entryReady(entry, providers))
            ? `No model in ${group === undefined ? 'Rotate usage' : `“${group.name}”`} is ready — check their providers in Settings → Providers`
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
  const choice = effective(choiceOf(live))
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
    coolingUntil: coolingUntil(entry),
    outOfUsage: outOfUsage(entry)
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
  const standard = effective(current())
  const top = own !== undefined ? choiceStatus(own, providers) : { ...standard, ...readiness(standard, providers), lastUsed: null }
  return {
    workspaceRoot,
    provider: top.provider,
    model: top.model,
    defaultProvider: fallback().provider,
    defaultModel: fallback().model,
    autoApprove: policy.isAutoApprove(),
    followUpMode: followUpMode(),
    providerReady: top.providerReady,
    blockedReason: top.blockedReason,
    lastUsed: top.lastUsed,
    sessions: Object.fromEntries([...sessions].map(([id, live]) => [id, choiceStatus(live, providers)])),
    rotation: rotationStatus(providers),
    rotationEnabled: rotationEnabled(),
    rotationGroups: rotationGroups(),
    rotationGroup: activeRotationGroupId()
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

  const choice = effective(choiceOf(live))
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
    // The group in use, or the whole pool: a model outside it is never kept.
    const pool = activeRotationEntries()
    // Resting or out of quota, it is no model to stay on.
    const usable = (entry: RotationEntry): boolean =>
      pool.some((item) => rotationKey(item) === rotationKey(entry)) &&
      ready(entry) && coolingUntil(entry) === null && outOfUsage(entry) === null
    const staying =
      current !== undefined &&
      (live.promptsOnEntry ?? 0) > 0 &&
      (live.promptsOnEntry ?? 0) < PROMPTS_PER_MODEL &&
      usable(current)
    let first: RotationEntry | undefined
    if (staying) {
      first = current
      live.promptsOnEntry = (live.promptsOnEntry ?? 0) + 1
    } else {
      // Its turn is up: someone else goes next, unless nobody else can.
      if (current !== undefined && live.promptsOnEntry !== undefined) tried.add(rotationKey(current))
      first = next()
      // A model that is resting or spent is no better than the healthy one it
      // would replace; the session starts another turn where it is instead.
      const healthy = current !== undefined && usable(current)
      if (healthy && (first === undefined || coolingUntil(first) !== null || outOfUsage(first) !== null)) first = current
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
    const kept = checkpointDir(sessionId)
    live.agent = new AgentSession(
      provider,
      gate,
      live.spec.mode,
      sessionFileRoot(sessionId),
      live.messages,
      live.spec.sessionId,
      {
        ...(kept !== null ? { checkpointDir: kept } : {}),
        instructions: () => ({ global: preferences().instructions, session: live.spec.instructions ?? '' })
      }
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
        (block): block is Extract<ContentBlock, { type: 'text' | 'tool_use' | 'tool_result' | 'display' }> =>
          (block.type === 'text' && block.internal !== true) || block.type === 'tool_use' || block.type === 'tool_result' || block.type === 'display'
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
        if (block.type === 'display') return block
        return {
          type: 'tool_result' as const,
          toolUseId: block.toolUseId,
          content: block.content,
          isError: block.isError,
          ...(block.diff !== undefined ? { diff: block.diff } : {})
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
  // A paused run is already stopping: its reservation lingers only until the
  // run's own cleanup finishes, and reverting is exactly what the pause was
  // for. Turning it away for that last sliver of the run made the button fail
  // on a fast click. Only a run still working (not paused) must be protected.
  if (runForSession(sessionId) !== null && !isPaused(sessionId)) {
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
      // Reopened since the turn ran: its files come back from disk all the same.
      const dir = checkpointDir(sessionId)
      const root = sessionFileRoot(sessionId)
      if (dir !== null && root !== null) {
        try {
          new CheckpointStore(dir, root).restoreFrom(i)
        } catch { /* The transcript revert stands even if files cannot be restored. */ }
      }
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

export interface TakenPrompt {
  prompt: string
  /** The rest of that turn as the model read it — attachment headers, images. */
  blocks: ContentBlock[]
  /** The files it carried, as viewers draw them. */
  attachments: AttachmentRef[]
}

/**
 * Takes back the `count`-th typed prompt from the end and all that followed —
 * replies, later prompts, their summaries, and the files their runs changed —
 * and hands that prompt back to be edited or sent again. Works on a session
 * reopened since, whose agent has not been built yet, the same way.
 */
export function takeBackPrompt(sessionId: string, count: number): TakenPrompt | null {
  const live = sessions.get(sessionId)
  if (live === undefined) return null
  if (!Number.isInteger(count) || count < 1) throw new Error('Choose a prompt to take back')
  if (runForSession(sessionId) !== null) throw new Error('Pause this session before editing its prompts')
  clearPause(sessionId)
  let taken: { prompt: string; attachments: ContentBlock[]; removed: Message[] } | null = null
  if (live.agent !== null) {
    taken = live.agent.takeBack(count)
  } else {
    let seen = 0
    for (let i = live.messages.length - 1; i >= 0 && taken === null; i--) {
      const message = live.messages[i]
      if (message === undefined || !isTypedPrompt(message) || ++seen < count) continue
      const typed = message.content.find((block) => block.type === 'text' && block.attachment === undefined && block.followUp === undefined && block.internal !== true)
      if (typed?.type !== 'text') return null
      const removed = live.messages.slice(i)
      live.messages.length = i
      const dir = checkpointDir(sessionId)
      const root = sessionFileRoot(sessionId)
      if (dir !== null && root !== null) {
        try {
          new CheckpointStore(dir, root).restoreFrom(i)
        } catch { /* The transcript still goes back even if files cannot. */ }
      }
      taken = { prompt: typed.text, attachments: message.content.filter((block) => block !== typed), removed }
    }
  }
  if (taken === null) return null
  // One summary per answered run, aligned from the end: the runs that went take theirs along.
  const runs = answeredRuns(taken.removed)
  if (runs > 0) live.summaries.splice(Math.max(0, live.summaries.length - runs), runs)
  persistSessions()
  announceTitle(sessionId)
  return {
    prompt: taken.prompt,
    blocks: taken.attachments,
    attachments: taken.attachments.flatMap((block) => (block.type === 'text' && block.attachment !== undefined ? [block.attachment] : []))
  }
}

/**
 * Folds everything before the latest prompt into one memory, on request —
 * the same compaction a run does on its own near the context ceiling. The
 * session's current agent does it, so a rotating session is not moved on.
 */
export async function compactSession(sessionId: string, gate: ApprovalGate): Promise<{ before: number; after: number }> {
  const live = sessions.get(sessionId)
  if (live === undefined) throw new Error('Unknown session; reopen this tab')
  if (runForSession(sessionId) !== null) throw new Error('Pause this session before compacting it')
  const status = getStatus(sessionId)
  if (live.agent === null && !status.providerReady) throw new Error(status.blockedReason ?? 'Agent is not ready')
  const agent = live.agent ?? getSession(sessionId, gate)
  return agent.compact(new AbortController().signal)
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

/** Before-images of what the session's runs changed, kept across restarts. */
function checkpointDir(sessionId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) return null
  return path.join(app.getPath('userData'), 'checkpoints', sessionId)
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
    ...(isPaused(live.spec.sessionId) ? { paused: true } : {}),
    ...(isPausedForRetry(live.spec.sessionId) ? { pausedForRetry: true } : {}),
    ...(live.choice !== undefined ? { choice: live.choice } : {})
  }))
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(`${target}.tmp`, JSON.stringify(data), { mode: 0o600 })
    renameSync(`${target}.tmp`, target)
  } catch (error) { console.error('Could not save session history:', (error as Error).message) }
}
export function listSessionSpecs(): SessionSpec[] { return [...sessions.values()].map(specOf) }
