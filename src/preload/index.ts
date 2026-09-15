import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type {
  AgentRequest,
  AnticodeApi,
  AppInfo,
  AppPreferences,
  ApprovalRequest,
  ApprovalResponse,
  AttachmentInfo,
  CredentialStatus,
  CustomProviderInput,
  FilePreview,
  McpServerStatus,
  ModelCatalogue,
  PricedModel,
  RemoteStatus,
  RoutedAgentEvent,
  SessionSnapshot,
  ProviderId,
  ProviderEdit,
  ProviderInfo,
  ProviderSelection,
  QueuedPrompt,
  RotationEntry,
  RotationGroupInput,
  SessionPause,
  SessionQueue,
  SessionSpec,
  SessionStatus,
  SessionTitle,
  UpdateState,
  WebSession
} from '../shared/ipc'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

const api: AnticodeApi = {
  listWebSessions: () => ipcRenderer.invoke(IpcChannel.WEB_LIST) as Promise<WebSession[]>,
  reportWebTab: (sessionId, tabId, url, title) =>
    ipcRenderer.invoke(IpcChannel.WEB_REPORT, sessionId, tabId, url, title) as Promise<WebSession[]>,
  openWebUrl: (sessionId: string, url: string, tabId?: string, title?: string) =>
    ipcRenderer.invoke(IpcChannel.WEB_OPEN, sessionId, url, tabId, title) as Promise<WebSession[]>,
  setWebVisible: (sessionId: string, visible: boolean) =>
    ipcRenderer.invoke(IpcChannel.WEB_VISIBLE, sessionId, visible) as Promise<WebSession[]>,
  setWebFull: (sessionId: string, full: boolean) =>
    ipcRenderer.invoke(IpcChannel.WEB_FULL, sessionId, full) as Promise<WebSession[]>,
  addWebTab: (sessionId: string, url?: string) =>
    ipcRenderer.invoke(IpcChannel.WEB_TAB_ADD, sessionId, url) as Promise<WebSession[]>,
  closeWebTab: (sessionId: string, tabId: string) =>
    ipcRenderer.invoke(IpcChannel.WEB_TAB_CLOSE, sessionId, tabId) as Promise<WebSession[]>,
  selectWebTab: (sessionId: string, tabId: string) =>
    ipcRenderer.invoke(IpcChannel.WEB_TAB_SELECT, sessionId, tabId) as Promise<WebSession[]>,
  forgetWebSession: (sessionId: string) =>
    ipcRenderer.invoke(IpcChannel.WEB_FORGET, sessionId) as Promise<WebSession[]>,
  onWebSessions: (listener) => subscribe<WebSession[]>(IpcChannel.WEB_UPDATED, listener),
  listSessions: () => ipcRenderer.invoke(IpcChannel.SESSION_LIST) as Promise<SessionSpec[]>,
  releaseAttachments: (ids) => ipcRenderer.invoke(IpcChannel.ATTACH_RELEASE, ids) as Promise<void>,
  pendingApprovals: () => ipcRenderer.invoke(IpcChannel.APPROVAL_PENDING) as Promise<ApprovalRequest[]>,
  onApprovalDismissed: (listener) => subscribe<string>(IpcChannel.APPROVAL_DISMISSED, listener),
  listRuns: () => ipcRenderer.invoke(IpcChannel.RUN_LIST) as ReturnType<AnticodeApi['listRuns']>,
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.APP_INFO) as Promise<AppInfo>,
  getStatus: () => ipcRenderer.invoke(IpcChannel.STATUS) as Promise<SessionStatus>,
  onStatus: (listener) => subscribe<SessionStatus>(IpcChannel.STATUS_UPDATED, listener),
  onProviders: (listener) => subscribe<ProviderInfo[]>(IpcChannel.PROVIDERS_UPDATED, listener),
  chooseWorkspace: () => ipcRenderer.invoke(IpcChannel.WORKSPACE_CHOOSE) as Promise<SessionStatus>,
  setWorkspace: (root: string) =>
    ipcRenderer.invoke(IpcChannel.WORKSPACE_SET, root) as Promise<SessionStatus>,
  listProviders: () => ipcRenderer.invoke(IpcChannel.PROVIDER_LIST) as Promise<ProviderInfo[]>,
  selectProvider: (selection: ProviderSelection, sessionId?: string | null) =>
    ipcRenderer.invoke(IpcChannel.PROVIDER_SELECT, selection, sessionId ?? null) as Promise<SessionStatus>,
  listModels: (provider: ProviderId, refresh?: boolean) =>
    ipcRenderer.invoke(IpcChannel.PROVIDER_MODELS, provider, refresh) as Promise<ModelCatalogue>,
  setRotation: (entries: RotationEntry[]) =>
    ipcRenderer.invoke(IpcChannel.ROTATION_SET, entries) as Promise<SessionStatus>,
  resetRotationUsage: () => ipcRenderer.invoke(IpcChannel.ROTATION_RESET) as Promise<SessionStatus>,
  setRotationEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(IpcChannel.ROTATION_ENABLE, enabled) as Promise<SessionStatus>,
  setRotationGroups: (groups: RotationGroupInput[]) =>
    ipcRenderer.invoke(IpcChannel.ROTATION_GROUPS_SET, groups) as Promise<SessionStatus>,
  selectRotationGroup: (id: string | null) =>
    ipcRenderer.invoke(IpcChannel.ROTATION_GROUP_SELECT, id) as Promise<SessionStatus>,
  setAutoApprove: (enabled: boolean) =>
    ipcRenderer.invoke(IpcChannel.POLICY_SET, enabled) as Promise<SessionStatus>,
  setFollowUpMode: (mode: 'steer' | 'queue') =>
    ipcRenderer.invoke(IpcChannel.FOLLOW_UP_SET, mode) as Promise<SessionStatus>,
  addProvider: (input: CustomProviderInput) =>
    ipcRenderer.invoke(IpcChannel.PROVIDER_ADD, input) as Promise<ProviderInfo[]>,
  getRemoteStatus: () => ipcRenderer.invoke(IpcChannel.REMOTE_STATUS) as Promise<RemoteStatus>,
  onSessionCreated: (listener: (spec: SessionSpec) => void) =>
    subscribe<SessionSpec>(IpcChannel.SESSION_CREATED, listener),
  onSessionClosed: (listener: (sessionId: string) => void) =>
    subscribe<string>(IpcChannel.SESSION_CLOSED, listener),
  onSessionTitle: (listener) => subscribe<SessionTitle>(IpcChannel.SESSION_TITLE, listener),
  revertLastTurn: (sessionId: string) =>
    ipcRenderer.invoke(IpcChannel.SESSION_REVERT, sessionId) as Promise<string | null>,
  setSessionInstructions: (sessionId, instructions) =>
    ipcRenderer.invoke(IpcChannel.SESSION_INSTRUCTIONS, sessionId, instructions) as Promise<SessionSpec>,
  takeBackPrompt: (sessionId, count) =>
    ipcRenderer.invoke(IpcChannel.SESSION_TAKE_BACK, sessionId, count) as ReturnType<AnticodeApi['takeBackPrompt']>,
  regenerate: (sessionId, runId, choice) =>
    ipcRenderer.invoke(IpcChannel.SESSION_REGENERATE, sessionId, runId, choice) as ReturnType<AnticodeApi['regenerate']>,
  compactSession: (sessionId: string) =>
    ipcRenderer.invoke(IpcChannel.SESSION_COMPACT, sessionId) as Promise<{ before: number; after: number }>,
  exportSession: (sessionId, options) =>
    ipcRenderer.invoke(IpcChannel.SESSION_EXPORT, sessionId, options) as ReturnType<AnticodeApi['exportSession']>,
  getSessionSnapshot: (sessionId: string) =>
    ipcRenderer.invoke(IpcChannel.SESSION_SNAPSHOT, sessionId) as Promise<SessionSnapshot | null>,
  setRemoteEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(IpcChannel.REMOTE_SET, enabled) as Promise<RemoteStatus>,
  regenerateRemoteToken: () =>
    ipcRenderer.invoke(IpcChannel.REMOTE_REGENERATE) as Promise<RemoteStatus>,
  removeProvider: (id: ProviderId) =>
    ipcRenderer.invoke(IpcChannel.PROVIDER_REMOVE, id) as Promise<ProviderInfo[]>,
  updateProvider: (id: ProviderId, edit: ProviderEdit) =>
    ipcRenderer.invoke(IpcChannel.PROVIDER_UPDATE, id, edit) as Promise<ProviderInfo[]>,
  createSession: (spec: SessionSpec) =>
    ipcRenderer.invoke(IpcChannel.SESSION_CREATE, spec) as Promise<SessionSpec>,
  cloneSession: (sourceSessionId, newSessionId, throughPrompt, colour) =>
    ipcRenderer.invoke(
      IpcChannel.SESSION_CLONE,
      sourceSessionId,
      newSessionId,
      throughPrompt,
      colour
    ) as Promise<SessionSpec>,
  setSessionColour: (sessionId: string, colour: number) =>
    ipcRenderer.invoke(IpcChannel.SESSION_COLOUR, sessionId, colour) as Promise<void>,
  closeSession: (sessionId: string) =>
    ipcRenderer.invoke(IpcChannel.SESSION_CLOSE, sessionId) as Promise<void>,
  chooseAttachments: () =>
    ipcRenderer.invoke(IpcChannel.ATTACH_CHOOSE) as Promise<AttachmentInfo[]>,
  addAttachments: (paths: string[]) =>
    ipcRenderer.invoke(IpcChannel.ATTACH_ADD, paths) as Promise<AttachmentInfo[]>,
  addAttachmentData: (name: string, base64: string) =>
    ipcRenderer.invoke(IpcChannel.ATTACH_DATA, name, base64) as Promise<AttachmentInfo[]>,
  readAttachmentImage: (target: string) =>
    ipcRenderer.invoke(IpcChannel.ATTACH_READ_IMAGE, target) as Promise<string | null>,
  openAttachment: (target: string) =>
    ipcRenderer.invoke(IpcChannel.ATTACH_OPEN, target) as Promise<string | null>,
  openArtifact: (sessionId: string, relativePath: string) =>
    ipcRenderer.invoke(IpcChannel.ARTIFACT_OPEN, sessionId, relativePath) as Promise<string | null>,
  saveArtifact: (sessionId: string, relativePath: string) =>
    ipcRenderer.invoke(IpcChannel.ARTIFACT_SAVE, sessionId, relativePath) as Promise<string | null>,
  revealArtifact: (sessionId: string, relativePath: string) =>
    ipcRenderer.invoke(IpcChannel.ARTIFACT_REVEAL, sessionId, relativePath) as Promise<string | null>,
  previewFile: (sessionId: string | null, target: string) =>
    ipcRenderer.invoke(IpcChannel.FILE_PREVIEW, sessionId, target) as Promise<FilePreview>,
  // Electron removed File.path; a dropped file's location comes from here.
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  sendPrompt: (req: AgentRequest) =>
    ipcRenderer.invoke(IpcChannel.AGENT_SEND, req) as Promise<{ runId: string; steered: boolean }>,
  queuePrompt: (req: AgentRequest) =>
    ipcRenderer.invoke(IpcChannel.QUEUE_ADD, req) as Promise<{ runId: string; queued: boolean }>,
  unqueuePrompt: (sessionId, id) =>
    ipcRenderer.invoke(IpcChannel.QUEUE_REMOVE, sessionId, id) as Promise<QueuedPrompt | null>,
  onSessionQueue: (listener) => subscribe<SessionQueue>(IpcChannel.QUEUE_UPDATED, listener),
  getCredentialStatus: () => ipcRenderer.invoke(IpcChannel.CREDENTIALS_STATUS) as Promise<CredentialStatus>,
  moveEnvCredentials: () => ipcRenderer.invoke(IpcChannel.CREDENTIALS_MOVE) as Promise<CredentialStatus>,
  restrictEnvFile: () => ipcRenderer.invoke(IpcChannel.CREDENTIALS_RESTRICT) as Promise<CredentialStatus>,
  listMcpServers: () => ipcRenderer.invoke(IpcChannel.MCP_LIST) as Promise<McpServerStatus[]>,
  saveMcpServer: (input) => ipcRenderer.invoke(IpcChannel.MCP_SAVE, input) as Promise<McpServerStatus[]>,
  removeMcpServer: (id) => ipcRenderer.invoke(IpcChannel.MCP_REMOVE, id) as Promise<McpServerStatus[]>,
  reconnectMcpServer: (id) => ipcRenderer.invoke(IpcChannel.MCP_RECONNECT, id) as Promise<McpServerStatus[]>,
  importMcpServers: (json) => ipcRenderer.invoke(IpcChannel.MCP_IMPORT, json) as Promise<number>,
  onMcpServers: (listener) => subscribe<McpServerStatus[]>(IpcChannel.MCP_UPDATED, listener),
  listPrices: (models) => ipcRenderer.invoke(IpcChannel.PRICING_LIST, models) as Promise<PricedModel[]>,
  setPrice: (model, price) => ipcRenderer.invoke(IpcChannel.PRICING_SET, model, price) as Promise<void>,
  getPreferences: () => ipcRenderer.invoke(IpcChannel.PREFERENCES_GET) as Promise<AppPreferences>,
  setPreferences: (patch) => ipcRenderer.invoke(IpcChannel.PREFERENCES_SET, patch) as Promise<AppPreferences>,
  onPreferences: (listener) => subscribe<AppPreferences>(IpcChannel.PREFERENCES_UPDATED, listener),
  onSessionFocus: (listener) => subscribe<string>(IpcChannel.SESSION_FOCUS, listener),
  sendQuickCapture: (capture) => ipcRenderer.invoke(IpcChannel.QUICK_SEND, capture) as Promise<string>,
  hideQuickCapture: () => ipcRenderer.invoke(IpcChannel.QUICK_HIDE) as Promise<void>,
  onQuickOpened: (listener) => subscribe<void>(IpcChannel.QUICK_OPENED, () => listener()),
  getUpdateState: () => ipcRenderer.invoke(IpcChannel.UPDATE_STATE) as Promise<UpdateState>,
  configureUpdates: (patch) => ipcRenderer.invoke(IpcChannel.UPDATE_CONFIGURE, patch) as Promise<UpdateState>,
  checkForUpdates: () => ipcRenderer.invoke(IpcChannel.UPDATE_CHECK) as Promise<UpdateState>,
  downloadUpdate: () => ipcRenderer.invoke(IpcChannel.UPDATE_DOWNLOAD) as Promise<UpdateState>,
  installUpdate: () => ipcRenderer.invoke(IpcChannel.UPDATE_INSTALL) as Promise<void>,
  onUpdateState: (listener) => subscribe<UpdateState>(IpcChannel.UPDATE_EVENT, listener),
  cancelRun: (runId: string) => ipcRenderer.invoke(IpcChannel.AGENT_CANCEL, runId) as Promise<void>,
  pauseSession: (sessionId: string) =>
    ipcRenderer.invoke(IpcChannel.SESSION_PAUSE, sessionId) as Promise<boolean>,
  listPausedSessions: () => ipcRenderer.invoke(IpcChannel.SESSION_PAUSED_LIST) as Promise<string[]>,
  onSessionPaused: (listener) => subscribe<SessionPause>(IpcChannel.SESSION_PAUSED, listener),
  onSessionHistory: (listener) => subscribe<string>(IpcChannel.SESSION_HISTORY, listener),
  respondToApproval: (response: ApprovalResponse) =>
    ipcRenderer.invoke(IpcChannel.APPROVAL_RESPOND, response) as Promise<void>,
  onAgentEvent: (listener) => subscribe<RoutedAgentEvent>(IpcChannel.AGENT_EVENT, listener),
  onApprovalRequest: (listener) =>
    subscribe<ApprovalRequest>(IpcChannel.APPROVAL_REQUEST, listener)
}

contextBridge.exposeInMainWorld('anticode', api)
