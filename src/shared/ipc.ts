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
  ATTACH_DATA: 'attachment:data',
  ARTIFACT_OPEN: 'artifact:open',
  ARTIFACT_SAVE: 'artifact:save',
  RUN_LIST: 'agent:runs',
  AGENT_SEND: 'agent:send',
  AGENT_CANCEL: 'agent:cancel',
  AGENT_EVENT: 'agent:event',
  APPROVAL_DISMISSED: 'approval:dismissed',
  APPROVAL_PENDING: 'approval:pending',
  ATTACH_RELEASE: 'attachment:release',
  APPROVAL_REQUEST: 'approval:request',
  APPROVAL_RESPOND: 'approval:respond',
  PROVIDER_ADD: 'provider:add',
  PROVIDER_REMOVE: 'provider:remove',
  REMOTE_STATUS: 'remote:status',
  REMOTE_SET: 'remote:set',
  REMOTE_REGENERATE: 'remote:regenerate',
  SESSION_CREATED: 'session:created',
  SESSION_CLOSED: 'session:closed',
  SESSION_SNAPSHOT: 'session:snapshot'
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

export interface CustomProviderInput {
  label: string
  kind: 'openai' | 'ollama'
  baseURL: string
  apiKey: string
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
}

export interface SessionStatus {
  /** The folder last picked in the Projects screen, not a per-session binding. */
  workspaceRoot: string | null
  provider: ProviderId
  model: string
  autoApprove: boolean
  /** Whether the selected provider has credentials and a model name. */
  providerReady: boolean
  blockedReason: string | null
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

export type AgentEndReason = 'complete' | 'cancelled' | 'max_tokens' | 'refusal'

export type AgentEvent =
  /** Emitted by the routing layer before the run starts, so every viewer sees
   * the prompt the moment it is sent — never only after the turn ends. */
  | { type: 'prompt'; runId: string; text: string; attachments?: AttachmentRef[] }
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
  | { type: 'end'; runId: string; reason: AgentEndReason }
  | { type: 'error'; runId: string; message: string }

/**
 * The loop does not know its session id; the IPC and remote layers attach it
 * when routing events, so every window can tell which transcript they touch.
 */
export type RoutedAgentEvent = AgentEvent & { sessionId: string }

export interface RemoteStatus {
  enabled: boolean
  /** Full pairing URL for the phone, null when disabled or on error. */
  url: string | null
  token: string | null
  error: string | null
}

export type SnapshotBlock =
  | { type: 'text'; text: string }
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
  getRemoteStatus: () => Promise<RemoteStatus>
  setRemoteEnabled: (enabled: boolean) => Promise<RemoteStatus>
  /** Issues a fresh pairing token; every previously shared link stops working. */
  regenerateRemoteToken: () => Promise<RemoteStatus>
  /** Fires for sessions created anywhere — desktop or remote phone. */
  onSessionCreated: (listener: (spec: SessionSpec) => void) => () => void
  /** Fires when a session is deleted from the remote phone. */
  onSessionClosed: (listener: (sessionId: string) => void) => () => void
  getSessionSnapshot: (
    sessionId: string
  ) => Promise<{ messages: SnapshotMessage[]; summaries: RunSummary[] } | null>
  listSessions: () => Promise<SessionSpec[]>
  releaseAttachments: (ids: string[]) => Promise<void>
  pendingApprovals: () => Promise<ApprovalRequest[]>
  onApprovalDismissed: (listener: (requestId: string) => void) => () => void
  listRuns: () => Promise<{ runId: string; sessionId: string; startedAt: number }[]>
  getAppInfo: () => Promise<AppInfo>
  getStatus: () => Promise<SessionStatus>
  chooseWorkspace: () => Promise<SessionStatus>
  setWorkspace: (root: string) => Promise<SessionStatus>
  listProviders: () => Promise<ProviderInfo[]>
  selectProvider: (selection: ProviderSelection) => Promise<SessionStatus>
  listModels: (provider: ProviderId, refresh?: boolean) => Promise<ModelCatalogue>
  setAutoApprove: (enabled: boolean) => Promise<SessionStatus>
  createSession: (spec: SessionSpec) => Promise<void>
  closeSession: (sessionId: string) => Promise<void>
  chooseAttachments: () => Promise<AttachmentInfo[]>
  addAttachments: (paths: string[]) => Promise<AttachmentInfo[]>
  /** Attaches bytes that have no file of their own — a pasted screenshot. */
  addAttachmentData: (name: string, base64: string) => Promise<AttachmentInfo[]>
  /** Opens an attachment in whatever app the OS associates with it. */
  openAttachment: (path: string) => Promise<string | null>
  /** Opens a file the agent produced, resolved inside the session's folder. */
  openArtifact: (sessionId: string, relativePath: string) => Promise<string | null>
  /** Save-a-copy dialog for a produced file; resolves to the chosen path. */
  saveArtifact: (sessionId: string, relativePath: string) => Promise<string | null>
  pathForFile: (file: File) => string
  sendPrompt: (req: AgentRequest) => Promise<void>
  cancelRun: (runId: string) => Promise<void>
  respondToApproval: (response: ApprovalResponse) => Promise<void>
  addProvider: (input: CustomProviderInput) => Promise<ProviderInfo[]>
  removeProvider: (id: ProviderId) => Promise<ProviderInfo[]>
  onAgentEvent: (listener: (event: RoutedAgentEvent) => void) => () => void
  onApprovalRequest: (listener: (request: ApprovalRequest) => void) => () => void
}
