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
  SESSION_COMPACT: 'session:compact',
  SESSION_TAKE_BACK: 'session:takeBack',
  SESSION_INSTRUCTIONS: 'session:instructions',
  SESSION_REGENERATE: 'session:regenerate',
  CREDENTIALS_STATUS: 'credentials:status',
  CREDENTIALS_MOVE: 'credentials:move',
  CREDENTIALS_RESTRICT: 'credentials:restrict',
  MCP_LIST: 'mcp:list',
  MCP_SAVE: 'mcp:save',
  MCP_REMOVE: 'mcp:remove',
  MCP_RECONNECT: 'mcp:reconnect',
  MCP_IMPORT: 'mcp:import',
  MCP_UPDATED: 'mcp:updated',
  PRICING_LIST: 'pricing:list',
  PRICING_SET: 'pricing:set',
  PREFERENCES_GET: 'preferences:get',
  PREFERENCES_SET: 'preferences:set',
  PREFERENCES_UPDATED: 'preferences:updated',
  SESSION_FOCUS: 'session:focus',
  QUICK_SEND: 'quick:send',
  QUICK_HIDE: 'quick:hide',
  QUICK_OPENED: 'quick:opened',
  UPDATE_STATE: 'update:state',
  UPDATE_CONFIGURE: 'update:configure',
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  UPDATE_EVENT: 'update:event',
  QUEUE_ADD: 'queue:add',
  QUEUE_REMOVE: 'queue:remove',
  QUEUE_UPDATED: 'queue:updated',
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
 * The instruction a resume sends. It is the app picking a paused run back up,
 * not a prompt anyone typed: viewers show a marker instead, and editing or
 * retrying counts only the prompts that were typed.
 */
export const CONTINUE_PROMPT =
  'Lanjutkan langsung dari titik terakhir tanpa pembuka seperti “lanjutan”. Jangan ulangi langkah yang sudah selesai. Jika fragmen kata terakhir belum lengkap, tulis hanya sambungan yang hilang lalu teruskan.'

export const PAUSE_LABEL = 'Paused.'
export const RESUME_LABEL = 'Resumed.'
export const FOLLOW_UP_LABEL = 'Follow-up added.'

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
  ollama: 'http://127.0.0.1:11434/v1',
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
  /**
   * Every model the group rotates over: the ones picked by hand, then each
   * model switched on for a linked provider — so readers never expand links.
   */
  entries: RotationEntry[]
  /**
   * Providers the group takes whole: every model of theirs switched on in
   * Settings → Models belongs to it, including ones switched on later.
   */
  providers: string[]
}

/**
 * A group as Settings sends it: one made just now has no id yet. Entries of a
 * linked provider may come back in `entries`; the link already covers them.
 * Leaving `providers` out keeps the links the group had.
 */
export interface RotationGroupInput {
  id?: string
  name: string
  entries: RotationEntry[]
  providers?: string[]
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
  /** Added to this session's system prompt, after the global instructions. */
  instructions?: string
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

/** Conservative known-text-only check; unknown models avoid a false warning. */
export function modelCannotSeeImages(model: string | null | undefined): boolean {
  if (model === undefined || model === null || model === '') return false
  return /deepseek-(?:v[34].*flash|chat|coder)|llama3\.2(?!.*vision)/i.test(model)
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

/** What an export writes: which prompts, in which format, masked or not, with files or not. */
export interface ExportOptions {
  format: 'markdown' | 'json'
  /** Typed prompts from..to, 0-based and inclusive; null is the whole session. */
  range: { from: number; to: number } | null
  /** Mask API keys, tokens, and passwords — the ones anticode knows and ones that look like them. */
  redact: boolean
  /** Copy attachments and produced documents into a folder beside the export. */
  assets: boolean
}

export interface ExportResult {
  path: string
  /** Files copied into the assets folder. */
  assets: number
  /** Files the transcript names that were no longer there. */
  missing: string[]
}

/** A secret-looking variable in the .env file, never with its value. */
export interface EnvCredential {
  name: string
  /** The first and last four characters, or dots for a short one. */
  masked: string
  /** The provider that reads it, when anticode does. */
  usedBy: string | null
  /** anticode can take it into sealed storage. */
  movable: boolean
}

export interface CredentialStatus {
  /** The OS keychain can seal secrets typed into Settings. */
  secureStorage: boolean
  envFile: string | null
  /** Accounts other than its owner can read the .env file. */
  envFileOpen: boolean
  envKeys: EnvCredential[]
}

/** An MCP server as Settings sends it. A blank secret value keeps the saved one. */
export interface McpServerInput {
  id?: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  /** stdio: the program and its arguments. */
  command: string
  args: string[]
  env: Record<string, string>
  /** http: the Streamable HTTP endpoint, and headers such as Authorization. */
  url: string
  headers: Record<string, string>
  /** Its tools run without asking. Off, every call is approved like a built-in edit. */
  trust: boolean
}

/** An MCP server as Settings shows it; secret values never leave the main process. */
export interface McpServerStatus {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  url: string
  trust: boolean
  envKeys: string[]
  headerKeys: string[]
  state: 'off' | 'connecting' | 'ready' | 'error'
  error: string | null
  tools: { name: string; description: string; destructive: boolean }[]
}

/** US dollars per million tokens. */
export interface ModelPrice {
  input: number
  output: number
}

export interface PricedModel extends ProviderSelection {
  price: ModelPrice | null
  /** Typed in Settings, published by the gateway, built in, a free tier, or not known. */
  source: 'custom' | 'gateway' | 'built-in' | 'free' | 'unknown'
}

/** App-wide choices from Settings → General. */
export type NotificationKind = 'complete' | 'error' | 'approval' | 'update'

/** Which system notifications show, and how. Clicking one opens its session. */
export interface NotificationSettings extends Record<NotificationKind, boolean> {
  /** Off mutes every kind at once. */
  enabled: boolean
  sound: boolean
  /** Only while anticode is not the focused app. */
  background: boolean
}

export interface AppPreferences {
  /** An icon in the menu bar (the tray elsewhere) with quick capture and recent sessions. */
  tray: boolean
  notifications: NotificationSettings
  /** Added to every session's system prompt, antichat and anticode alike. */
  instructions: string
}

/** How long instructions may be, global or per session. */
export const INSTRUCTIONS_MAX_CHARS = 8_000

/** What the quick capture panel sends: a prompt, and where it should go. */
export interface QuickCapture {
  text: string
  /** antichat, or anticode in the folder last picked in the Projects screen. */
  mode: SessionMode
  /** Bring the main window up on the new session instead of staying out of the way. */
  open: boolean
}

/** Where updates come from, and how much happens without asking. */
export interface UpdateSettings {
  /** A GitHub repository (owner/repo), a feed URL, or a local folder; empty is none. */
  source: string
  /** Ask the source at start-up and every six hours. */
  autoCheck: boolean
  /** Download a newer build as soon as it is found. Installing always waits for a click. */
  autoDownload: boolean
}

export interface UpdateState extends UpdateSettings {
  status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error'
  /** The version running now. */
  current: string
  latest: string | null
  notes: string | null
  /** 0–1 while downloading. */
  progress: number | null
  error: string | null
  checkedAt: number | null
  /** False in a dev run: there is no app bundle of anticode's own to replace. */
  canInstall: boolean
}

/** A prompt waiting for the session's run to finish, to go out as the next run. */
export interface QueuedPrompt {
  id: string
  text: string
  attachments: AttachmentRef[]
}

export interface SessionQueue {
  sessionId: string
  items: QueuedPrompt[]
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
  | {
      type: 'prompt'
      runId: string
      text: string
      attachments?: AttachmentRef[]
      /** The actual model selected for this run, before any response arrives. */
      provider?: string
      model?: string
    }
  /** An instruction sent while this run was already working. The run keeps
   * going and takes it in at its next step, instead of a second run starting.
   * Viewers show it at once; what the run is still writing stays above it. */
  | { type: 'steer'; runId: string; text: string; attachments?: AttachmentRef[] }
  /** The run has read the instructions sent so far; what it writes from here
   * on answers them, and belongs below them. */
  | { type: 'steer_taken'; runId: string }
  | { type: 'text_delta'; runId: string; text: string }
  | { type: 'tool_start'; runId: string; toolUseId: string; name: string; input: unknown }
  /** A line of progress from a tool still running — a sub-agent's steps. */
  | { type: 'tool_progress'; runId: string; toolUseId: string; text: string }
  | {
      type: 'tool_end'
      runId: string
      toolUseId: string
      ok: boolean
      output: string
      rejected?: boolean
      /** A file change as a unified diff, drawn in the transcript. */
      diff?: string
    }
  | {
      type: 'usage'
      runId: string
      provider: string
      model: string
      inputTokens: number
      outputTokens: number
      /** The provider id behind `provider` (which is its display name), for pricing. */
      providerId?: string
      /** Estimated dollars, set by the main process; null when the model has no price. */
      costUsd?: number | null
      /**
       * Spent on a side request — a sub-agent, or the memory written when the
       * context is compacted. It counts toward the run's cost, but that request
       * is not the session's context, so the context meter ignores it.
       */
      subagent?: boolean
      /** The stream ended before the provider's final usage chunk. */
      estimated?: boolean
    }
  /** A line the app writes about the run itself — the context was compacted. */
  | { type: 'notice'; runId: string; text: string }
  | {
      type: 'end'
      runId: string
      reason: AgentEndReason
      summary?: RunSummary
      /** The model whose half-written reply was kept as a turn when the run stopped. */
      keptReplyModel?: string
    }
  | {
      type: 'error'
      runId: string
      message: string
      /** As on `end`: a kept partial reply is a turn, and every turn has a summary. */
      keptReplyModel?: string
      /** A temporary provider/network failure: the session can continue from its saved partial state. */
      retryable?: boolean
      summary?: RunSummary
    }

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
  /** Paused because the connection dropped, not by anyone: no "take a break" marker. */
  pausedForRetry?: boolean
  revision: number
  events: RoutedAgentEvent[]
  /** Prompts waiting for this session's run to finish. */
  queue: QueuedPrompt[]
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
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean; diff?: string }
  /** UI-only run state persisted with the transcript; providers never receive it. */
  | { type: 'display'; kind: 'notice' | 'error'; text: string }

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
  /** Estimated dollars for the requests whose model has a price. */
  costUsd?: number
  /** Some request's model had no price, so the estimate is short of the truth. */
  costPartial?: boolean
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
  /**
   * Takes back the `count`-th typed prompt from the end and everything after
   * it — replies, later prompts, and the files their runs changed — and
   * returns that prompt and its files, to edit and send again.
   */
  takeBackPrompt: (
    sessionId: string,
    count: number
  ) => Promise<{ prompt: string; attachments: AttachmentRef[] } | null>
  /**
   * Answers the last prompt again as a new run with `runId`, on `choice` when
   * one is given; the old reply and its file changes are taken back first.
   */
  regenerate: (
    sessionId: string,
    runId: string,
    choice: ProviderSelection | null
  ) => Promise<{ runId: string; steered: boolean }>
  /** Instructions for one session, from its next request on; answers the settled spec. */
  setSessionInstructions: (sessionId: string, instructions: string) => Promise<SessionSpec>
  /** Drops the last exchange and returns its prompt, for retyping. */
  revertLastTurn: (sessionId: string) => Promise<string | null>
  /**
   * Folds everything before the latest prompt into a memory the model writes.
   * Answers with the replay estimate, in tokens, before and after.
   */
  compactSession: (sessionId: string) => Promise<{ before: number; after: number }>
  /** Saves the transcript through an OS dialog; null when the dialog was cancelled. */
  exportSession: (sessionId: string, options?: ExportOptions) => Promise<ExportResult | null>
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
  /**
   * Queues a prompt to go out as its own run once the session's run finishes
   * (it starts at once when nothing is running). `queued` is false then.
   */
  queuePrompt: (req: AgentRequest) => Promise<{ runId: string; queued: boolean }>
  /** Takes a prompt off the queue; answers it, so it can be edited instead. */
  unqueuePrompt: (sessionId: string, id: string) => Promise<QueuedPrompt | null>
  onSessionQueue: (listener: (queue: SessionQueue) => void) => () => void
  getCredentialStatus: () => Promise<CredentialStatus>
  /** Seals the .env keys anticode uses and comments them out of the file. */
  moveEnvCredentials: () => Promise<CredentialStatus>
  /** chmod 600 on the .env file. */
  restrictEnvFile: () => Promise<CredentialStatus>
  listMcpServers: () => Promise<McpServerStatus[]>
  saveMcpServer: (input: McpServerInput) => Promise<McpServerStatus[]>
  removeMcpServer: (id: string) => Promise<McpServerStatus[]>
  reconnectMcpServer: (id: string) => Promise<McpServerStatus[]>
  /** Servers from another client's `mcpServers` JSON; answers how many were added. */
  importMcpServers: (json: string) => Promise<number>
  onMcpServers: (listener: (servers: McpServerStatus[]) => void) => () => void
  /** Prices for these models, and where each came from. */
  listPrices: (models: ProviderSelection[]) => Promise<PricedModel[]>
  /** A price for a model id, typed in Settings; null goes back to the built-in or published one. */
  setPrice: (model: string, price: ModelPrice | null) => Promise<void>
  getPreferences: () => Promise<AppPreferences>
  setPreferences: (patch: Partial<AppPreferences>) => Promise<AppPreferences>
  onPreferences: (listener: (preferences: AppPreferences) => void) => () => void
  /** The main process asks for a session to be shown — tray, quick capture, a notification. */
  onSessionFocus: (listener: (sessionId: string) => void) => () => void
  /** Quick capture: starts a new session with the prompt; resolves to its id. */
  sendQuickCapture: (capture: QuickCapture) => Promise<string>
  hideQuickCapture: () => Promise<void>
  /** The quick capture panel was shown again: focus the field. */
  onQuickOpened: (listener: () => void) => () => void
  getUpdateState: () => Promise<UpdateState>
  configureUpdates: (patch: Partial<UpdateSettings>) => Promise<UpdateState>
  checkForUpdates: () => Promise<UpdateState>
  downloadUpdate: () => Promise<UpdateState>
  /** Quits and swaps in the downloaded build; the new version opens by itself. */
  installUpdate: () => Promise<void>
  onUpdateState: (listener: (state: UpdateState) => void) => () => void
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
