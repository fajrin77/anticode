import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type {
  AgentEvent,
  AgentRequest,
  AnticodeApi,
  AppInfo,
  ApprovalRequest,
  ApprovalResponse,
  AttachmentInfo,
  CustomProviderInput,
  ModelCatalogue,
  RemoteStatus,
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
  getSessionSnapshot: (sessionId: string) =>
    ipcRenderer.invoke(IpcChannel.SESSION_SNAPSHOT, sessionId) as Promise<SnapshotMessage[] | null>,
  setRemoteEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(IpcChannel.REMOTE_SET, enabled) as Promise<RemoteStatus>,
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
  // Electron removed File.path; a dropped file's location comes from here.
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  sendPrompt: (req: AgentRequest) =>
    ipcRenderer.invoke(IpcChannel.AGENT_SEND, req) as Promise<void>,
  cancelRun: (runId: string) => ipcRenderer.invoke(IpcChannel.AGENT_CANCEL, runId) as Promise<void>,
  respondToApproval: (response: ApprovalResponse) =>
    ipcRenderer.invoke(IpcChannel.APPROVAL_RESPOND, response) as Promise<void>,
  onAgentEvent: (listener) => subscribe<AgentEvent>(IpcChannel.AGENT_EVENT, listener),
  onApprovalRequest: (listener) =>
    subscribe<ApprovalRequest>(IpcChannel.APPROVAL_REQUEST, listener)
}

contextBridge.exposeInMainWorld('anticode', api)
