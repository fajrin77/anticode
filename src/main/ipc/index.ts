import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { stat } from 'node:fs/promises'
import type { WebContents } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type {
  AgentEvent,
  AgentRequest,
  AppInfo,
  ApprovalResponse,
  ModelCatalogue,
  ProviderId,
  ProviderInfo,
  ProviderSelection,
  RoutedAgentEvent,
  SessionSpec,
  SessionStatus
} from '@shared/ipc'
import {
  closeSession,
  createSession,
  getSession,
  getStatus,
  listModels,
  loadSessionMessages,
  policy,
  resetProviderSelection,
  selectProvider,
  setOnSessionCreated,
  setWorkspaceRoot
} from '../runtime'
import { listProviders } from '../providers'
import { ApprovalCoordinator } from '../approval/coordinator'
import { AttachmentError, prepareAttachment, toContentBlocks } from '../attachments'
import { addCustomProvider, removeCustomProvider } from '../providers/custom'
import { savePersistedSettings } from '../settings'
import { forgetRun, forward, registerRun } from '../remote/bus'
import { getRemoteStatus, regenerateRemoteToken, setRemoteEnabled } from '../remote/server'
import type { CustomProviderInput } from '@shared/ipc'
import type { AttachmentInfo } from '@shared/ipc'

const activeRuns = new Map<string, AbortController>()
const attachments = new Map<string, AttachmentInfo>()

let lastSender: WebContents | null = null

const approvals = new ApprovalCoordinator(policy, () => lastSender)

/** The remote server reuses the same gate and targets the desktop window. */
export { approvals }
export function focusApprovalTarget(sender: WebContents): void {
  lastSender = sender
}

/** Every agent event routes through the bus, which reaches all windows and
 * SSE subscribers; no separate direct send, or windows would get duplicates. */
function emit(event: AgentEvent, sessionId: string): void {
  forward({ ...event, sessionId } as RoutedAgentEvent)
}

export function registerIpcHandlers(): void {
  ipcMain.handle(
    IpcChannel.APP_INFO,
    (): AppInfo => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node,
      platform: process.platform,
      isPackaged: app.isPackaged
    })
  )

  ipcMain.handle(IpcChannel.STATUS, (): SessionStatus => getStatus())

  ipcMain.handle(IpcChannel.PROVIDER_LIST, (): ProviderInfo[] => listProviders())

  ipcMain.handle(
    IpcChannel.PROVIDER_SELECT,
    (_event, selection: ProviderSelection): SessionStatus => {
      selectProvider(selection)
      return getStatus()
    }
  )

  ipcMain.handle(
    IpcChannel.PROVIDER_MODELS,
    (_event, provider: ProviderId, refresh?: boolean): Promise<ModelCatalogue> =>
      listModels(provider, refresh === true)
  )

  ipcMain.handle(IpcChannel.POLICY_SET, (_event, enabled: boolean): SessionStatus => {
    policy.setAutoApprove(enabled)
    savePersistedSettings({ autoApprove: enabled })
    return getStatus()
  })

  ipcMain.handle(
    IpcChannel.PROVIDER_ADD,
    (_event, input: CustomProviderInput): ProviderInfo[] => {
      addCustomProvider({
        label: input.label.trim() !== '' ? input.label.trim() : 'Provider',
        kind: input.kind,
        baseURL: input.baseURL.trim(),
        apiKey: input.apiKey.trim()
      })
      return listProviders()
    }
  )

  ipcMain.handle(IpcChannel.PROVIDER_REMOVE, (_event, id: string): ProviderInfo[] => {
    removeCustomProvider(id)
    if (getStatus().provider === id) resetProviderSelection()
    return listProviders()
  })

  ipcMain.handle(IpcChannel.REMOTE_STATUS, (): ReturnType<typeof getRemoteStatus> =>
    getRemoteStatus()
  )

  ipcMain.handle(IpcChannel.REMOTE_SET, (_event, enabled: boolean) => setRemoteEnabled(enabled))

  ipcMain.handle(IpcChannel.REMOTE_REGENERATE, () => regenerateRemoteToken())

  ipcMain.handle(IpcChannel.WORKSPACE_CHOOSE, async (event): Promise<SessionStatus> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })

    const chosen = result.filePaths[0]
    if (!result.canceled && chosen !== undefined) setWorkspaceRoot(chosen)
    return getStatus()
  })

  ipcMain.handle(IpcChannel.WORKSPACE_SET, async (_event, root: string): Promise<SessionStatus> => {
    const info = await stat(root).catch(() => null)
    if (info?.isDirectory() === true) setWorkspaceRoot(root)
    return getStatus()
  })

  async function register(paths: string[]): Promise<AttachmentInfo[]> {
    const root = getStatus().workspaceRoot
    // Atomic: one unreadable file would otherwise register a half batch the
    // user cannot see. Every failure is named so the bad file is findable.
    const settled = await Promise.allSettled(paths.map((file) => prepareAttachment(file, root)))
    const failures = settled
      .filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
      .map((entry) => (entry.reason as Error).message)

    const prepared = settled
      .filter((entry): entry is PromiseFulfilledResult<AttachmentInfo> => entry.status === 'fulfilled')
      .map((entry) => entry.value)
    for (const item of prepared) attachments.set(item.id, item)

    if (failures.length > 0) {
      if (prepared.length === 0) throw new AttachmentError(failures.join('\n'))
      throw new AttachmentError(
        `${prepared.length} attached, ${failures.length} failed:\n${failures.join('\n')}`
      )
    }
    return prepared
  }

  ipcMain.handle(IpcChannel.ATTACH_CHOOSE, async (event): Promise<AttachmentInfo[]> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { properties: ['openFile', 'multiSelections'] as const }
    const result = window
      ? await dialog.showOpenDialog(window, { properties: [...options.properties] })
      : await dialog.showOpenDialog({ properties: [...options.properties] })

    return result.canceled ? [] : register(result.filePaths)
  })

  ipcMain.handle(
    IpcChannel.ATTACH_ADD,
    (_event, paths: string[]): Promise<AttachmentInfo[]> => register(paths)
  )

  ipcMain.handle(IpcChannel.APPROVAL_RESPOND, (_event, response: ApprovalResponse): void => {
    approvals.resolve(response.requestId, response.decision)
  })

  ipcMain.handle(IpcChannel.SESSION_CREATE, (_event, spec: SessionSpec): void => {
    createSession(spec)
  })

  ipcMain.handle(IpcChannel.SESSION_SNAPSHOT, (_event, sessionId: string) =>
    loadSessionMessages(sessionId)
  )

  setOnSessionCreated((spec) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.SESSION_CREATED, spec)
      }
    }
  })

  ipcMain.handle(IpcChannel.SESSION_CLOSE, (_event, sessionId: string): void => {
    closeSession(sessionId)
  })

  ipcMain.handle(IpcChannel.AGENT_SEND, (event, req: AgentRequest): void => {
    lastSender = event.sender

    // Events only travel through the bus, so the run must be registered even
    // when the send is refused — the error has to reach the windows.
    registerRun(req.runId, req.sessionId)

    const status = getStatus()
    if (!status.providerReady) {
      // The send is refused before any run starts; releasing the attachments
      // here keeps them from leaking — the renderer has already dropped them.
      for (const id of req.attachmentIds) attachments.delete(id)
      emit({
        type: 'error',
        runId: req.runId,
        message: status.blockedReason ?? 'Agent is not ready'
      }, req.sessionId)
      forgetRun(req.runId)
      return
    }

    if (activeRuns.has(req.runId)) return
    const controller = new AbortController()
    activeRuns.set(req.runId, controller)

    void (async () => {
      try {
        const blocks = await Promise.all(
          req.attachmentIds
            .map((id) => attachments.get(id))
            .filter((item): item is AttachmentInfo => item !== undefined)
            .map(toContentBlocks)
        )

        await getSession(req.sessionId, approvals).run({
          runId: req.runId,
          prompt: req.prompt,
          signal: controller.signal,
          emit: (agentEvent) => emit(agentEvent, req.sessionId),
          attachments: blocks.flat()
        })
      } catch (error) {
        emit({ type: 'error', runId: req.runId, message: (error as Error).message }, req.sessionId)
      } finally {
        for (const id of req.attachmentIds) attachments.delete(id)
        forgetRun(req.runId)
        activeRuns.delete(req.runId)
      }
    })()
  })

  ipcMain.handle(IpcChannel.AGENT_CANCEL, (_event, runId: string): void => {
    activeRuns.get(runId)?.abort()
  })
}
