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
  SessionSpec,
  SessionStatus
} from '@shared/ipc'
import {
  closeSession,
  createSession,
  getSession,
  getStatus,
  listModels,
  policy,
  selectProvider,
  setWorkspaceRoot
} from '../runtime'
import { listProviders } from '../providers'
import { ApprovalCoordinator } from '../approval/coordinator'
import { prepareAttachment, toContentBlocks } from '../attachments'
import type { AttachmentInfo } from '@shared/ipc'

const activeRuns = new Map<string, AbortController>()
const attachments = new Map<string, AttachmentInfo>()

let lastSender: WebContents | null = null

const approvals = new ApprovalCoordinator(policy, () => lastSender)

function emit(sender: WebContents, event: AgentEvent): void {
  if (sender.isDestroyed()) return
  sender.send(IpcChannel.AGENT_EVENT, event)
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
    return getStatus()
  })

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
    const prepared = await Promise.all(paths.map((file) => prepareAttachment(file, root)))
    for (const item of prepared) attachments.set(item.id, item)
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

  ipcMain.handle(IpcChannel.SESSION_CLOSE, (_event, sessionId: string): void => {
    closeSession(sessionId)
  })

  ipcMain.handle(IpcChannel.AGENT_SEND, (event, req: AgentRequest): void => {
    lastSender = event.sender

    const status = getStatus()
    if (!status.providerReady) {
      emit(event.sender, {
        type: 'error',
        runId: req.runId,
        message: status.blockedReason ?? 'Agent belum siap'
      })
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
          emit: (agentEvent) => emit(event.sender, agentEvent),
          attachments: blocks.flat()
        })
      } catch (error) {
        emit(event.sender, { type: 'error', runId: req.runId, message: (error as Error).message })
      } finally {
        for (const id of req.attachmentIds) attachments.delete(id)
        activeRuns.delete(req.runId)
      }
    })()
  })

  ipcMain.handle(IpcChannel.AGENT_CANCEL, (_event, runId: string): void => {
    activeRuns.get(runId)?.abort()
  })
}
