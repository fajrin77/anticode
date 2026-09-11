export const IpcChannel = {
  APP_INFO: 'app:info',
  STATUS: 'session:status',
  WORKSPACE_CHOOSE: 'workspace:choose',
  WORKSPACE_SET: 'workspace:set',
  PROVIDER_LIST: 'provider:list',
  PROVIDER_SELECT: 'provider:select',
  PROVIDER_MODELS: 'provider:models',
  POLICY_SET: 'policy:set',
  SESSION_LIST: 'session:list',
  SESSION_CREATE: 'session:create',
  SESSION_CLOSE: 'session:close',
  ATTACH_CHOOSE: 'attachment:choose',
  ATTACH_ADD: 'attachment:add',
  ATTACH_OPEN: 'attachment:open',
  ATTACH_READ_IMAGE: 'attachment:readImage',
  ATTACH_DATA: 'attachment:data',
  ARTIFACT_OPEN: 'artifact:open',
  ARTIFACT_SAVE: 'artifact:save',
  RUN_LIST: 'agent:runs',
  AGENT_SEND: 'agent:send',
  AGENT_CANCEL: 'agent:cancel',
  SESSION_PAUSE: 'session:pause',
  SESSION_PAUSED: 'session:paused',
  SESSION_PAUSED_LIST: 'session:pausedList',
  SESSION_HISTORY: 'session:history',
  STATUS_UPDATED: 'session:statusUpdated',
  PROVIDERS_UPDATED: 'provider:updated',
  SESSION_REVERT: 'session:revert',
  SESSION_EXPORT: 'session:export',
  AGENT_EVENT: 'agent:event',
  APPROVAL_DISMISSED: 'approval:dismissed',
  APPROVAL_PENDING: 'approval:pending',
  ATTACH_RELEASE: 'attachment:release',
  APPROVAL_REQUEST: 'approval:request',
  APPROVAL_RESPOND: 'approval:respond',
  PROVIDER_ADD: 'provider:add',
  PROVIDER_REMOVE: 'provider:remove',
  PROVIDER_UPDATE: 'provider:update',
  ROTATION_SET: 'rotation:set',
  ROTATION_RESET: 'rotation:reset',
  ROTATION_ENABLE: 'rotation:enable',
  ROTATION_GROUPS_SET: 'rotation:groups',
  ROTATION_GROUP_SELECT: 'rotation:group',
  REMOTE_STATUS: 'remote:status',
  REMOTE_SET: 'remote:set',
  REMOTE_REGENERATE: 'remote:regenerate',
  SESSION_CREATED: 'session:created',
  SESSION_CLOSED: 'session:closed',
  SESSION_SNAPSHOT: 'session:snapshot',
  SESSION_COLOUR: 'session:colour',
  SESSION_TITLE: 'session:title',
  FILE_PREVIEW: 'file:preview',
  WEB_LIST: 'web:list',
  WEB_OPEN: 'web:open',
  WEB_REPORT: 'web:report',
  WEB_VISIBLE: 'web:visible',
  WEB_FULL: 'web:full',
  WEB_TAB_ADD: 'web:tabAdd',
  WEB_TAB_CLOSE: 'web:tabClose',
  WEB_TAB_SELECT: 'web:tabSelect',
  WEB_FORGET: 'web:forget',
  WEB_UPDATED: 'web:updated'
} as const

/**
 * Replay budget the agent trims its history against; the UI shows the same
 * number as the context ceiling so both sides agree on "how full am I".
 */
export const HISTORY_TOKEN_BUDGET = 100_000

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  isPackaged: boolean
}

/**
 * Built-in ids plus `custom:<uuid>` entries the user adds in Settings — any
 * OpenAI-compatible endpoint (cloud gateway or a local server like Ollama).
 */
export type ProviderId = string

/**
 * 'openai' is any OpenAI-compatible gateway, 'ollama' a local server,
 * 'anthropic' and 'openai-api' the vendors' own APIs under an API key, and
 * 'clinepass' the built-in gateway.
 */
export type ProviderKind = 'openai' | 'ollama' | 'anthropic' | 'openai-api' | 'clinepass'

/** Where a vendor API lives when its Base URL is left empty. */
export const VENDOR_BASE_URLS: Partial<Record<ProviderKind, string>> = {
  anthropic: 'https://api.anthropic.com',
  'openai-api': 'https://api.openai.com/v1'
}

export interface CustomProviderInput {
  label: string
  /** 'clinepass' brings back the built-in gateway after it was removed. */
  kind: ProviderKind
  baseURL: string
  apiKey: string
  /** Model ids typed by the user; the first is the one the provider starts on. */
  models?: string[]
}

export interface ProviderInfo {
  id: ProviderId
  label: string
  /** Empty when the provider has no stable default and the user must name one. */
  defaultModel: string
  credentialAvailable: boolean
  /** True only when the user actually set this provider's env vars. */
  configured: boolean
  credentialHint: string
  /** The model ids typed for it in Settings (Clinepass: its subscription list). */
  models?: string[]
  kind?: ProviderKind
  /** Where it is reached. The key is never sent, only whether one is saved. */
  baseURL?: string
  /** A key is saved for it. The key itself never leaves the main process. */
  hasKey?: boolean
}

/** A change made in Settings. Blank or missing fields keep what is there. */
export interface ProviderEdit {
  label?: string
  baseURL?: string
  apiKey?: string
  models?: string[]
}

export interface ModelCatalogue {
  provider: ProviderId
  models: string[]
  /** Set when the provider could not be queried; the UI then offers free text. */
  error: string | null
}

export interface ProviderSelection {
  provider: ProviderId
  model: string
}

/**
 * The choice that is not one model: the session takes turns over the Rotate
 * usage pool, two prompts on each model, moving to the entry that has used
 * the fewest tokens. Its model is always ''.
 */
export const ROTATE_PROVIDER = 'rotate'
/** Compact composer label; Settings keeps the fuller “Rotate usage” wording. */
export const ROTATE_LABEL = 'rotate'

/** One model in the Rotate usage pool. */
export interface RotationEntry {
  provider: ProviderId
  model: string
}

export interface RotationEntryStatus extends RotationEntry {
  label: string
  /** Tokens this model has used since the last reset, from every session. */
  inputTokens: number
  outputTokens: number
  /** Its provider is there and has credentials. */
  ready: boolean
  /** Set while it rests after a rate limit or failure; others go first. */
  coolingUntil: number | null
  /**
   * Set once its provider said the quota or credit behind it is spent. It is
   * tried only when nothing else can take the prompt, and shows in Settings so
   * it can be replaced. A reply from it again, or Reset counts, clears it.
   */
  outOfUsage: OutOfUsage | null
}

export interface OutOfUsage {
  since: number
  /** What the provider said, shortened. */
  reason: string
}

/**
 * A named part of the Rotate usage pool — "code only", "media only" — for
 * models that suit one kind of work. Whichever group is in use is what every
 * session rotates over; none in use means the whole pool.
 */
export interface RotationGroup {
  id: string
  name: string
  entries: RotationEntry[]
}

/** A group as Settings sends it: one made just now has no id yet. */
export interface RotationGroupInput {
  id?: string
  name: string
  entries: RotationEntry[]
}

/** A session's own model — each tab keeps the one it was given. */
export interface ModelChoice extends ProviderSelection {
  providerReady: boolean
  blockedReason: string | null
  /** Rotation only: where the session's latest prompt went. */
  lastUsed: ProviderSelection | null
}

/** §8 risk tiers: low runs unattended, medium can be pre-approved, high never can. */
export type RiskTier = 'low' | 'medium' | 'high'

export interface ToolPreview {
  kind: 'diff' | 'command' | 'text'
  subject: string
  detail: string
}

export interface ApprovalRequest {
  requestId: string
  runId: string
  toolName: string
  risk: RiskTier
  preview: ToolPreview
  /** False for high-risk calls, which must be approved individually every time. */
  allowAlways: boolean
}

export type ApprovalDecision = 'approve' | 'reject' | 'always'

export interface ApprovalResponse {
  requestId: string
  decision: ApprovalDecision
}

/**
 * Chat never touches the filesystem, so it is offered no tools and needs no
 * folder. Code binds to a project folder for the life of the session.
 */
export type SessionMode = 'chat' | 'code'

export interface SessionSpec {
  sessionId: string
  mode: SessionMode
  workspaceRoot: string | null
  /**
   * Index into the badge palette. The main process owns it so the desktop and
   * the phone paint a session the same colour; a desktop may propose one when
   * it creates the session, and the main process keeps whatever it settles on.
   */
  colour?: number
  /**
   * The session's name, filled in by the main process on the way out — a
   * folder's name, or antichat's first prompt. Viewers show it, never derive it.
   */
  title?: string
}

export interface SessionTitle {
  sessionId: string
  title: string
}

/** One page of a rendered preview: a sheet of a workbook, or the whole document. */
export interface PreviewPage {
  label: string
  /** A complete, script-free HTML document, drawn in a sandboxed frame. */
  html: string
  /** Set when only part of the file fits, e.g. "First 500 of 12,000 rows". */
  note?: string
}

/**
 * A file shown inside the app rather than handed to another one. Documents
 * are rendered to HTML by the main process, so the desktop and the phone show
 * the same thing; pictures and PDFs are drawn by the viewer itself, from bytes
 * (`data`, base64) on the desktop and from a URL on the phone.
 */
export type FilePreview =
  | { kind: 'pages'; name: string; pages: PreviewPage[] }
  | { kind: 'image'; name: string; mime: string; data?: string }
  | { kind: 'pdf'; name: string; data?: string }
  | { kind: 'none'; name: string; reason: string }

/**
 * Badge palette, shared by both viewers. The phone page carries a literal copy
 * (it cannot import this module); a unit test holds the two to each other.
 */
export const SESSION_COLOURS: [string, string][] = [
  ['#7a5cc4', '#4f3a8f'],
  ['#3f8f86', '#2c6b64'],
  ['#c2603f', '#8f4630'],
  ['#3f7fc2', '#2c5e92'],
  ['#b0873a', '#82632c'],
  ['#8f4f7a', '#6a3c5c'],
  ['#4f8f4f', '#386b38'],
  ['#c24f7a', '#923a5c'],
  ['#5c7ac2', '#43598f'],
  ['#c27a3f', '#925c30']
]

export interface SessionStatus {
  /** The folder last picked in the Projects screen, not a per-session binding. */
  workspaceRoot: string | null
  /**
   * The model new sessions start on — the one picked last, anywhere. A
   * session that exists has its own in `sessions`; statusFor reads it.
   */
  provider: ProviderId
  model: string
  /** Provider/model used when Rotate usage is off. */
  defaultProvider: ProviderId
  defaultModel: string
  autoApprove: boolean
  /** Whether the selected provider has credentials and a model name. */
  providerReady: boolean
  blockedReason: string | null
  /** Every session's own model, by session id. */
  sessions: Record<string, ModelChoice>
  /** The Rotate usage pool, with what each entry has used. */
  rotation: RotationEntryStatus[]
  /**
   * Rotate usage is switched on in Settings. Off, Rotate is not offered as a
   * model and no token is counted; the pool is still the composer's list.
   */
  rotationEnabled: boolean
  /** The named parts of the pool, in the order they were made. */
  rotationGroups: RotationGroup[]
  /** The group every session rotates over; null is the whole pool. */
  rotationGroup: string | null
  /** Always null here: only a session has a latest prompt to point at. */
  lastUsed: ProviderSelection | null
}

/** The group in use, or null when sessions rotate over the whole pool. */
export function activeRotationGroup(
  status: Pick<SessionStatus, 'rotationGroups' | 'rotationGroup'> | null
): RotationGroup | null {
  if (status === null || status.rotationGroup === null) return null
  return (status.rotationGroups ?? []).find((group) => group.id === status.rotationGroup) ?? null
}

/** The pool entries sessions rotate over right now: the group's, or all of them. */
export function activeRotationEntries(
  status: Pick<SessionStatus, 'rotation' | 'rotationGroups' | 'rotationGroup'> | null
): RotationEntryStatus[] {
  const pool = status?.rotation ?? []
  const group = activeRotationGroup(status)
  if (group === null) return pool
  return group.entries.flatMap((entry) =>
    pool.filter((item) => item.provider === entry.provider && item.model === entry.model)
  )
}

/**
 * The status as one session sees it: its own model over the default. A
 * session not in the map (a draft not yet created) is on the default.
 */
export function statusFor(status: SessionStatus, sessionId: string | null | undefined): SessionStatus {
  const own = sessionId === null || sessionId === undefined ? undefined : status.sessions[sessionId]
  return own === undefined ? status : { ...status, ...own }
}

/**
 * What a model chip says: the model, or Rotate, the group in use, and where
 * it went last.
 */
export function modelLabel(
  status:
    | (Pick<SessionStatus, 'provider' | 'model' | 'lastUsed'> &
        Partial<Pick<SessionStatus, 'rotationGroups' | 'rotationGroup'>>)
    | null
): string {
  if (status === null) return '…'
  if (status.provider === ROTATE_PROVIDER) {
    const group = activeRotationGroup({
      rotationGroups: status.rotationGroups ?? [],
      rotationGroup: status.rotationGroup ?? null
    })
    return [
      ROTATE_LABEL,
      ...(group !== null ? [group.name] : []),
      ...(status.lastUsed !== null && status.lastUsed.model !== '' ? [status.lastUsed.model] : [])
    ].join(' · ')
  }
  return status.model === '' ? 'pick a model' : status.model
}

/**
 * The caller supplies runId so it can map incoming events to its own state
 * before the first event arrives.
 */
export type AttachmentKind = 'image' | 'text' | 'excel' | 'docx' | 'pdf' | 'binary'

/**
 * What every viewer needs to draw an attachment: its name, its kind, and a
 * small picture for images. Rides in the transcript so a reopened session
 * still shows the files that were sent, not just their names.
 */
export interface AttachmentRef {
  name: string
  path: string
  /** Set when the file sits inside the workspace, so tools can reach it too. */
  workspacePath: string | null
  kind: AttachmentKind
  size: number
  /** Small data: URL for images; null for every other kind. */
  thumbnail: string | null
}

export interface AttachmentInfo extends AttachmentRef {
  id: string
  preview: string
}

export interface AgentRequest {
  sessionId: string
  runId: string
  prompt: string
  attachmentIds: string[]
}

/** A session's pause starting or ending, told to every viewer by the main process. */
export interface SessionPause {
  sessionId: string
  paused: boolean
}

export type AgentEndReason = 'complete' | 'cancelled' | 'max_tokens' | 'refusal'

export type AgentEvent =
  /** Emitted by the routing layer before the run starts, so every viewer sees
   * the prompt the moment it is sent — never only after the turn ends. */
  | { type: 'prompt'; runId: string; text: string; attachments?: AttachmentRef[] }
  /** An instruction sent while this run was already working. The run keeps
   * going and takes it in at its next step, instead of a second run starting.
   * Viewers show it at once; what the run is still writing stays above it. */
  | { type: 'steer'; runId: string; text: string; attachments?: AttachmentRef[] }
  /** The run has read the instructions sent so far; what it writes from here
   * on answers them, and belongs below them. */
  | { type: 'steer_taken'; runId: string }
  | { type: 'text_delta'; runId: string; text: string }
  | { type: 'tool_start'; runId: string; toolUseId: string; name: string; input: unknown }
  | {
      type: 'tool_end'
      runId: string
      toolUseId: string
      ok: boolean
      output: string
      rejected?: boolean
    }
  | {
      type: 'usage'
      runId: string
      provider: string
      model: string
      inputTokens: number
      outputTokens: number
    }
  | { type: 'end'; runId: string; reason: AgentEndReason; summary?: RunSummary }
  | { type: 'error'; runId: string; message: string; summary?: RunSummary }

/**
 * The loop does not know its session id; the IPC and remote layers attach it
 * when routing events, so every window can tell which transcript they touch.
 */
export type RoutedAgentEvent = AgentEvent & { sessionId: string; revision?: number }

export interface SessionSnapshot {
  messages: SnapshotMessage[]
  summaries: RunSummary[]
  runId: string | null
  paused: boolean
  revision: number
  events: RoutedAgentEvent[]
}

export interface RemoteStatus {
  enabled: boolean
  /** Full pairing URL for the phone, null when disabled or on error. */
  url: string | null
  token: string | null
  error: string | null
}

/** One page in a session's browser pane. */
export interface WebTab {
  id: string
  /** Empty for a tab that is open but has not been navigated to yet. */
  url: string
  title: string
}

/**
 * anticode's own browser, one per session. The agent drives a single page —
 * its Playwright page — which is always the active tab; the tabs beside it are
 * the user's own, opened from the pane.
 */
export interface WebSession {
  sessionId: string
  tabs: WebTab[]
  activeTabId: string
  /**
   * True once the user hid this session's pane. It stays true for the rest of
   * the session, so a page the agent opens later does not shove the pane back
   * on screen after the user has already said no.
   */
  hidden: boolean
  /** True when the pane has taken the whole window instead of the right side. */
  full: boolean
}

export type SnapshotBlock =
  | {
      type: 'text'
      text: string
      /**
       * Set on an instruction sent while a run was working. `during` means the
       * run took it in and carried on, so the assistant turn before it did not
       * end the run; `after` means the run was paused before it could.
       */
      followUp?: 'during' | 'after'
    }
  | { type: 'attachment'; attachment: AttachmentRef }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }

export interface SnapshotMessage {
  role: 'user' | 'assistant'
  blocks: SnapshotBlock[]
}

/**
 * What one finished run cost. Recorded in the main process so the desktop and
 * the phone close a run with the same line, and so it survives a restart —
 * both used to lose it the moment the transcript was reloaded.
 *
 * One summary per assistant turn, in order: a run that never got a response
 * records none, which is exactly what keeps the two lists aligned.
 */
export interface RunSummary {
  model: string
  durationMs: number
  inputTokens: number
  outputTokens: number
}

export interface AnticodeApi {
  /** Every session that has a browser pane, hidden ones included. */
  listWebSessions: () => Promise<WebSession[]>
  /**
   * Points a tab at a URL and shows the pane — the user asked for it. Without
   * a tab id the active one is navigated. Guest navigation and title events
   * use reportWebTab so background pages cannot change the user's selection.
   */
  openWebUrl: (
    sessionId: string,
    url: string,
    tabId?: string,
    title?: string
  ) => Promise<WebSession[]>
  setWebVisible: (sessionId: string, visible: boolean) => Promise<WebSession[]>
  reportWebTab: (sessionId: string, tabId: string, url: string, title?: string) => Promise<WebSession[]>
  /** Whole window versus the right-hand side. */
  setWebFull: (sessionId: string, full: boolean) => Promise<WebSession[]>
  addWebTab: (sessionId: string, url?: string) => Promise<WebSession[]>
  closeWebTab: (sessionId: string, tabId: string) => Promise<WebSession[]>
  selectWebTab: (sessionId: string, tabId: string) => Promise<WebSession[]>
  /** Drops the pane entirely; the next page the agent opens brings it back. */
  forgetWebSession: (sessionId: string) => Promise<WebSession[]>
  onWebSessions: (listener: (sessions: WebSession[]) => void) => () => void
  getRemoteStatus: () => Promise<RemoteStatus>
  setRemoteEnabled: (enabled: boolean) => Promise<RemoteStatus>
  /** Issues a fresh pairing token; every previously shared link stops working. */
  regenerateRemoteToken: () => Promise<RemoteStatus>
  /** Fires for sessions created anywhere — desktop or remote phone. */
  onSessionCreated: (listener: (spec: SessionSpec) => void) => () => void
  /** Fires when a session is deleted from the remote phone. */
  onSessionClosed: (listener: (sessionId: string) => void) => () => void
  /** Fires when the main process renames a session — antichat's first prompt. */
  onSessionTitle: (listener: (change: SessionTitle) => void) => () => void
  /** Drops the last exchange and returns its prompt, for retyping. */
  revertLastTurn: (sessionId: string) => Promise<string | null>
  /** Saves the complete transcript as Markdown or JSON through an OS dialog. */
  exportSession: (sessionId: string) => Promise<string | null>
  getSessionSnapshot: (
    sessionId: string
  ) => Promise<SessionSnapshot | null>
  listSessions: () => Promise<SessionSpec[]>
  releaseAttachments: (ids: string[]) => Promise<void>
  pendingApprovals: () => Promise<ApprovalRequest[]>
  onApprovalDismissed: (listener: (requestId: string) => void) => () => void
  listRuns: () => Promise<{ runId: string; sessionId: string; startedAt: number }[]>
  getAppInfo: () => Promise<AppInfo>
  getStatus: () => Promise<SessionStatus>
  /** Fires when the provider or model is changed from the phone. */
  onStatus: (listener: (status: SessionStatus) => void) => () => void
  /** Fires when a provider is added or removed, from either screen. */
  onProviders: (listener: (providers: ProviderInfo[]) => void) => () => void
  chooseWorkspace: () => Promise<SessionStatus>
  setWorkspace: (root: string) => Promise<SessionStatus>
  listProviders: () => Promise<ProviderInfo[]>
  /**
   * With a session id, that session changes model — no other one does, and a
   * run it has going keeps its model until it ends. The pick also becomes the
   * model new sessions start on; without an id that is all it changes.
   */
  selectProvider: (selection: ProviderSelection, sessionId?: string | null) => Promise<SessionStatus>
  listModels: (provider: ProviderId, refresh?: boolean) => Promise<ModelCatalogue>
  /** Replaces the Rotate usage pool. */
  setRotation: (entries: RotationEntry[]) => Promise<SessionStatus>
  /** Starts every pool entry's token count from zero. */
  resetRotationUsage: () => Promise<SessionStatus>
  /** Switches Rotate usage on or off; off moves sessions on Rotate to a plain model. */
  setRotationEnabled: (enabled: boolean) => Promise<SessionStatus>
  /** Replaces the Rotate usage groups; a model a group names joins the pool. */
  setRotationGroups: (groups: RotationGroupInput[]) => Promise<SessionStatus>
  /** The group every session rotates over from its next prompt; null for the whole pool. */
  selectRotationGroup: (id: string | null) => Promise<SessionStatus>
  setAutoApprove: (enabled: boolean) => Promise<SessionStatus>
  /** Answers with the spec as the main process settled it, colour included. */
  createSession: (spec: SessionSpec) => Promise<SessionSpec>
  closeSession: (sessionId: string) => Promise<void>
  chooseAttachments: () => Promise<AttachmentInfo[]>
  addAttachments: (paths: string[]) => Promise<AttachmentInfo[]>
  /** Attaches bytes that have no file of their own — a pasted screenshot. */
  addAttachmentData: (name: string, base64: string) => Promise<AttachmentInfo[]>
  /** Opens an attachment in whatever app the OS associates with it. */
  openAttachment: (path: string) => Promise<string | null>
  /** A data URL for an attached picture, so it opens inside the app. */
  readAttachmentImage: (path: string) => Promise<string | null>
  /** Opens a file the agent produced, resolved inside the session's folder. */
  openArtifact: (sessionId: string, relativePath: string) => Promise<string | null>
  /** Save-a-copy dialog for a produced file; resolves to the chosen path. */
  saveArtifact: (sessionId: string, relativePath: string) => Promise<string | null>
  /**
   * Renders a file for the in-app viewer: a produced one by its path inside
   * the session's folder, or an attachment (sessionId null) by absolute path.
   */
  previewFile: (sessionId: string | null, target: string) => Promise<FilePreview>
  pathForFile: (file: File) => string
  /**
   * Starts a run, or — when this session already has one working — hands the
   * prompt to that run as a follow-up. `steered` says which happened; a steer
   * answers with the run that was already going.
   */
  sendPrompt: (req: AgentRequest) => Promise<{ runId: string; steered: boolean }>
  /** Records the colour a desktop has been showing, for a session that has none. */
  setSessionColour: (sessionId: string, colour: number) => Promise<void>
  cancelRun: (runId: string) => Promise<void>
  /**
   * Pauses the session's run for every viewer. False when nothing was running
   * — the run had already finished, so there is nothing to resume.
   */
  pauseSession: (sessionId: string) => Promise<boolean>
  /** Sessions paused right now, from whichever screen. */
  listPausedSessions: () => Promise<string[]>
  onSessionPaused: (listener: (state: SessionPause) => void) => () => void
  /** Fires when a session's history changed on the phone (a turn was reverted). */
  onSessionHistory: (listener: (sessionId: string) => void) => () => void
  respondToApproval: (response: ApprovalResponse) => Promise<void>
  addProvider: (input: CustomProviderInput) => Promise<ProviderInfo[]>
  removeProvider: (id: ProviderId) => Promise<ProviderInfo[]>
  updateProvider: (id: ProviderId, edit: ProviderEdit) => Promise<ProviderInfo[]>
  onAgentEvent: (listener: (event: RoutedAgentEvent) => void) => () => void
  onApprovalRequest: (listener: (request: ApprovalRequest) => void) => () => void
}
