import type {
  ModelCatalogue,
  ProviderId,
  ProviderSelection,
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
    selection = { provider: chosen?.id ?? 'anthropic', model: chosen?.defaultModel ?? '' }
  }
  return selection
}

export function setWorkspaceRoot(root: string): void {
  workspaceRoot = root
}

/**
 * Agents are discarded on a provider switch: pending tool-call ids and message
 * shapes are provider-specific, and replaying one provider's half-finished turn
 * through another is not something we can make safe.
 */
export function selectProvider(next: ProviderSelection): void {
  const model = next.model.trim()
  selection = {
    provider: next.provider,
    // Fall back to whatever the catalogue offers so switching provider never
    // lands on an empty model box the user has to fill in by hand.
    model: model !== '' ? model : (catalogues.get(next.provider)?.models[0] ?? '')
  }
  for (const session of sessions.values()) session.agent = null
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
    for (const session of sessions.values()) session.agent = null
  }
  return catalogue
}

export function createSession(spec: SessionSpec): void {
  sessions.set(spec.sessionId, { spec, agent: null })
}

export function closeSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function getStatus(): SessionStatus {
  const active = current()
  const info = listProviders().find((p) => p.id === active.provider)

  const blockedReason =
    info?.credentialAvailable !== true
      ? `${info?.credentialHint ?? 'Kredensial'} belum diset — isi berkas .env lalu jalankan ulang app`
      : active.model === ''
        ? 'Model belum diisi untuk provider ini'
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
  if (!live) throw new Error('Sesi tidak dikenal; buka ulang tab ini')

  if (live.spec.mode === 'code' && live.spec.workspaceRoot === null) {
    throw new Error('Sesi Code butuh folder project')
  }

  if (!live.agent) {
    const active = current()
    live.agent = new AgentSession(
      createProvider(active.provider, active.model),
      gate,
      live.spec.mode,
      live.spec.workspaceRoot
    )
  }
  return live.agent
}

export function providerIds(): ProviderId[] {
  return listProviders().map((p) => p.id)
}
