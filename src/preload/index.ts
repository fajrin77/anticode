import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type {
  AgentRequest,
  AnticodeApi,
  AppInfo,
  ApprovalRequest,
  ApprovalResponse,
  AttachmentInfo,
  CustomProviderInput,
  ModelCatalogue,
  RemoteStatus,
  RoutedAgentEvent,
  RunSummary,
  SnapshotMessage,
  ProviderId,
  ProviderInfo,
  ProviderSelection,
  SessionSpec,
  SessionStatus
} from '../shared/ipc'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

const api: AnticodeApi = {
  listSessions: () => ipcRenderer.invoke(IpcChannel.SESSION_LIST) as Promise<SessionSpec[]>,
  releaseAttachments: (ids) => ipcRenderer.invoke(IpcChannel.ATTACH_RELEASE, ids) as Promise<void>,
  pendingApprovals: () => ipcRenderer.invoke(IpcChannel.APPROVAL_PENDING) as Promise<ApprovalRequest[]>,
  onApprovalDismissed: (listener) => subscribe<string>(IpcChannel.APPROVAL_DISMISSED, listener),
  listRuns: () => ipcRenderer.invoke(IpcChannel.RUN_LIST) as ReturnType<AnticodeApi['listRuns']>,
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.APP_INFO) as Promise<AppInfo>,
  getStatus: () => ipcRenderer.invoke(IpcChannel.STATUS) as Promise<SessionStatus>,
  chooseWorkspace: () => ipcRenderer.invoke(IpcChannel.WORKSPACE_CHOOSE) as Promise<SessionStatus>,
  setWorkspace: (root: string) =>
    ipcRenderer.invoke(IpcChannel.WORKSPACE_SET, root) as Promise<SessionStatus>,
  listProviders: () => ipcRenderer.invoke(IpcChannel.PROVIDER_LIST) as Promise<ProviderInfo[]>,
  selectProvider: (selection: ProviderSelection) =>
    ipcRenderer.invoke(IpcChannel.PROVIDER_SELECT, selection) as Promise<SessionStatus>,
  listModels: (provider: ProviderId, refresh?: boolean) =>
    ipcRenderer.invoke(IpcChannel.PROVIDER_MODELS, provider, refresh) as Promise<ModelCatalogue>,
  setAutoApprove: (enabled: boolean) =>
    ipcRenderer.invoke(IpcChannel.POLICY_SET, enabled) as Promise<SessionStatus>,
  addProvider: (input: CustomProviderInput) =>
    ipcRenderer.invoke(IpcChannel.PROVIDER_ADD, input) as Promise<ProviderInfo[]>,
  getRemoteStatus: () => ipcRenderer.invoke(IpcChannel.REMOTE_STATUS) as Promise<RemoteStatus>,
  onSessionCreated: (listener: (spec: SessionSpec) => void) =>
    subscribe<SessionSpec>(IpcChannel.SESSION_CREATED, listener),
  onSessionClosed: (listener: (sessionId: string) => void) =>
    subscribe<string>(IpcChannel.SESSION_CLOSED, listener),
  revertLastTurn: (sessionId: string) =>
    ipcRenderer.invoke(IpcChannel.SESSION_REVERT, sessionId) as Promise<string | null>,
  getSessionSnapshot: (sessionId: string) =>
    ipcRenderer.invoke(IpcChannel.SESSION_SNAPSHOT, sessionId) as Promise<{
      messages: SnapshotMessage[]
      summaries: RunSummary[]
    } | null>,
  setRemoteEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(IpcChannel.REMOTE_SET, enabled) as Promise<RemoteStatus>,
  regenerateRemoteToken: () =>
    ipcRenderer.invoke(IpcChannel.REMOTE_REGENERATE) as Promise<RemoteStatus>,
  removeProvider: (id: ProviderId) =>
    ipcRenderer.invoke(IpcChannel.PROVIDER_REMOVE, id) as Promise<ProviderInfo[]>,
  createSession: (spec: SessionSpec) =>
    ipcRenderer.invoke(IpcChannel.SESSION_CREATE, spec) as Promise<void>,
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
  // Electron removed File.path; a dropped file's location comes from here.
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  sendPrompt: (req: AgentRequest) =>
    ipcRenderer.invoke(IpcChannel.AGENT_SEND, req) as Promise<void>,
  cancelRun: (runId: string) => ipcRenderer.invoke(IpcChannel.AGENT_CANCEL, runId) as Promise<void>,
  respondToApproval: (response: ApprovalResponse) =>
    ipcRenderer.invoke(IpcChannel.APPROVAL_RESPOND, response) as Promise<void>,
  onAgentEvent: (listener) => subscribe<RoutedAgentEvent>(IpcChannel.AGENT_EVENT, listener),
  onApprovalRequest: (listener) =>
    subscribe<ApprovalRequest>(IpcChannel.APPROVAL_REQUEST, listener)
}

contextBridge.exposeInMainWorld('anticode', api)
