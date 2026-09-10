import {
  cancelRun,
  runForSession,
  hasRuns,
  listActiveRuns,
  listPausedSessions,
  pauseSession,
  setPauseSink
} from '../runs'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import { copyFile, readFile, stat } from 'node:fs/promises'
import type { WebContents } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type {
  AgentRequest,
  AppInfo,
  ApprovalResponse,
  FilePreview,
  ModelCatalogue,
  ProviderId,
  ProviderInfo,
  ProviderSelection,
  SessionSpec,
  SessionStatus
} from '@shared/ipc'
import {
  deleteSession,
  createSession,
  adoptSessionColour,
  getStatus,
  listModels,
  listSessionSpecs,
  sessionFileRoot,
  revertLastTurn,
  policy,
  resetProviderSelection,
  selectProvider,
  setOnSessionClosed,
  setOnSessionCreated,
  setOnSessionTitled,
  setRunningProbe,
  setWorkspaceRoot
} from '../runtime'
import { listProviders } from '../providers'
import { resolveInWorkspace } from '../tools/workspace'
import { ApprovalCoordinator } from '../approval/coordinator'
import {
  registerAttachmentData,
  registerAttachments,
  releaseAttachments
} from '../attachments/registry'
import { addCustomProvider, removeCustomProvider } from '../providers/custom'
import { savePersistedSettings } from '../settings'
import { announceHistory, announcePause, announceSessionTitle, announceStatus, sessionSnapshot } from '../remote/bus'
import { previewFile } from '../preview'
import {
  addWebTab,
  clearWeb,
  closeWebTab,
  listWeb,
  openWeb,
  reportWebTab,
  selectWebTab,
  setWebCloser,
  setWebFull,
  setWebSink,
  setWebVisible
} from '../web'
import { closePhonePage } from '../browser'
import { submitPrompt } from '../prompts'
import { getRemoteStatus, regenerateRemoteToken, setRemoteEnabled } from '../remote/server'
import type { CustomProviderInput } from '@shared/ipc'
import type { AttachmentInfo } from '@shared/ipc'

let lastSender: WebContents | null = null

const approvals = new ApprovalCoordinator(policy, () => lastSender && !lastSender.isDestroyed() ? lastSender : BrowserWindow.getAllWindows()[0]?.webContents ?? null, (requestId) => {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(IpcChannel.APPROVAL_DISMISSED, requestId)
})

/** The remote server reuses the same gate and targets the desktop window. */
export { approvals }
export function focusApprovalTarget(sender: WebContents): void {
  lastSender = sender
}

/** Produced files are named relative to the session folder; resolving them
 * here keeps the renderer from ever handling an absolute path of its own. */
function artifactPath(sessionId: string, relativePath: string): string {
  const root = sessionFileRoot(sessionId)
  if (root === null) throw new Error('This session has no project folder')
  return resolveInWorkspace(root, relativePath)
}

/**
 * Default or Auto, pressed on the desktop or the phone. Prompts from both obey
 * the one policy, so both screens are told which it is.
 */
export function setApprovalMode(enabled: boolean): SessionStatus {
  policy.setAutoApprove(enabled)
  savePersistedSettings({ autoApprove: enabled })
  announceStatus()
  return getStatus()
}

function announceProviders(): void {
  const providers = listProviders()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IpcChannel.PROVIDERS_UPDATED, providers)
  }
}

/** A provider added from either screen shows in every window's list at once. */
export function addProvider(input: CustomProviderInput): ProviderInfo[] {
  addCustomProvider({
    label: input.label.trim() !== '' ? input.label.trim() : 'Provider',
    kind: input.kind,
    baseURL: input.baseURL.trim(),
    apiKey: input.apiKey.trim()
  })
  announceProviders()
  return listProviders()
}

export function removeProvider(id: string): ProviderInfo[] {
  if (hasRuns()) throw new Error('Wait for running sessions to finish before removing a provider')
  removeCustomProvider(id)
  if (getStatus().provider === id) {
    resetProviderSelection()
    announceStatus()
  }
  announceProviders()
  return listProviders()
}

export function registerIpcHandlers(): void {
  // The pane's state is owned by the main process — the agent is what opens
  // pages — so every window is told about a change rather than asked for one.
  setWebSink((sessions) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IpcChannel.WEB_UPDATED, sessions)
    }
  })

  ipcMain.handle(IpcChannel.WEB_LIST, () => listWeb())

  // A pane that is forgotten takes the phone's mirror of it down too; the
  // agent's own page is left alone, because the agent may still be using it.
  setWebCloser((sessionId) => {
    void closePhonePage(sessionId)
  })

  ipcMain.handle(
    IpcChannel.WEB_OPEN,
    (_event, sessionId: string, url: string, tabId?: string, title?: string) => {
      openWeb(sessionId, url, tabId, typeof title === 'string' ? title : undefined)
      return listWeb()
    }
  )

  ipcMain.handle(IpcChannel.WEB_VISIBLE, (_event, sessionId: string, visible: boolean) => {
    setWebVisible(sessionId, visible)
    return listWeb()
  })

  ipcMain.handle(IpcChannel.WEB_REPORT, (_event, sessionId: string, tabId: string, url: string, title?: string) => {
    reportWebTab(sessionId, tabId, url, title)
    return listWeb()
  })

  ipcMain.handle(IpcChannel.WEB_FULL, (_event, sessionId: string, full: boolean) => {
    setWebFull(sessionId, full)
    return listWeb()
  })

  ipcMain.handle(IpcChannel.WEB_TAB_ADD, (_event, sessionId: string, url?: string) => {
    addWebTab(sessionId, url ?? '')
    return listWeb()
  })

  ipcMain.handle(IpcChannel.WEB_TAB_CLOSE, (_event, sessionId: string, tabId: string) => {
    closeWebTab(sessionId, tabId)
    return listWeb()
  })

  ipcMain.handle(IpcChannel.WEB_TAB_SELECT, (_event, sessionId: string, tabId: string) => {
    selectWebTab(sessionId, tabId)
    return listWeb()
  })

  ipcMain.handle(IpcChannel.WEB_FORGET, (_event, sessionId: string) => {
    clearWeb(sessionId)
    return listWeb()
  })

  // Paused on one screen, resumable from the other: the pause lives here.
  setPauseSink(announcePause)
  ipcMain.handle(IpcChannel.SESSION_PAUSE, (_event, sessionId: string) => pauseSession(sessionId))
  ipcMain.handle(IpcChannel.SESSION_PAUSED_LIST, () => listPausedSessions())

  ipcMain.handle(IpcChannel.RUN_LIST, () => listActiveRuns())
  ipcMain.handle(IpcChannel.ATTACH_RELEASE, (_event, ids: string[]) => releaseAttachments(ids))
  ipcMain.handle(IpcChannel.APPROVAL_PENDING, () => approvals.listPending())
  ipcMain.handle(IpcChannel.SESSION_LIST, () => listSessionSpecs())
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
      announceStatus()
      return getStatus()
    }
  )

  ipcMain.handle(
    IpcChannel.PROVIDER_MODELS,
    (_event, provider: ProviderId, refresh?: boolean): Promise<ModelCatalogue> =>
      listModels(provider, refresh === true)
  )

  ipcMain.handle(IpcChannel.POLICY_SET, (_event, enabled: boolean): SessionStatus =>
    setApprovalMode(enabled === true)
  )

  ipcMain.handle(
    IpcChannel.PROVIDER_ADD,
    (_event, input: CustomProviderInput): ProviderInfo[] => addProvider(input)
  )

  ipcMain.handle(IpcChannel.PROVIDER_REMOVE, (_event, id: string): ProviderInfo[] =>
    removeProvider(id)
  )

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

  ipcMain.handle(IpcChannel.ATTACH_CHOOSE, async (event): Promise<AttachmentInfo[]> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { properties: ['openFile', 'multiSelections'] as const }
    const result = window
      ? await dialog.showOpenDialog(window, { properties: [...options.properties] })
      : await dialog.showOpenDialog({ properties: [...options.properties] })

    return result.canceled ? [] : registerAttachments(result.filePaths)
  })

  ipcMain.handle(
    IpcChannel.ATTACH_ADD,
    (_event, paths: string[]): Promise<AttachmentInfo[]> => registerAttachments(paths)
  )

  ipcMain.handle(
    IpcChannel.ATTACH_DATA,
    (_event, name: string, base64: string): Promise<AttachmentInfo[]> =>
      registerAttachmentData(name, Buffer.from(base64, 'base64'))
  )

  // Opening is by absolute path because an attachment may well sit outside any
  // project folder — the picture the user dragged in from their desktop.
  // Pictures open in the app, not in Preview: leaving anticode to look at a
  // screenshot the user just sent is a round trip nobody asked for.
  ipcMain.handle(
    IpcChannel.ATTACH_READ_IMAGE,
    async (_event, target: string): Promise<string | null> => {
      const extension = path.extname(target).toLowerCase()
      const type = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp'
      }[extension]
      if (type === undefined) return null
      try {
        const data = await readFile(target)
        // Past this the data URL costs more than the round trip saves.
        if (data.byteLength > 40 * 1024 * 1024) return null
        return `data:${type};base64,${data.toString('base64')}`
      } catch {
        return null
      }
    }
  )

  ipcMain.handle(IpcChannel.ATTACH_OPEN, async (_event, target: string): Promise<string | null> => {
    const failure = await shell.openPath(target)
    return failure === '' ? null : failure
  })

  ipcMain.handle(
    IpcChannel.ARTIFACT_OPEN,
    async (_event, sessionId: string, relativePath: string): Promise<string | null> => {
      const failure = await shell.openPath(artifactPath(sessionId, relativePath))
      return failure === '' ? null : failure
    }
  )

  // Save-a-copy: the produced file already lives in the project folder, this
  // just puts it somewhere the user actually keeps things.
  ipcMain.handle(
    IpcChannel.ARTIFACT_SAVE,
    async (event, sessionId: string, relativePath: string): Promise<string | null> => {
      const source = artifactPath(sessionId, relativePath)
      const window = BrowserWindow.fromWebContents(event.sender)
      const options = { defaultPath: path.basename(source) }
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || result.filePath === undefined) return null
      await copyFile(source, result.filePath)
      return result.filePath
    }
  )

  // Looked at in the app, not handed to another one: a produced file by its
  // path in the session's folder, an attachment by the absolute path it has.
  ipcMain.handle(
    IpcChannel.FILE_PREVIEW,
    (_event, sessionId: string | null, target: string): Promise<FilePreview> =>
      previewFile(sessionId === null ? target : artifactPath(sessionId, target), true)
  )

  ipcMain.handle(IpcChannel.APPROVAL_RESPOND, (_event, response: ApprovalResponse): void => {
    approvals.resolve(response.requestId, response.decision)
  })

  ipcMain.handle(IpcChannel.SESSION_CREATE, (_event, spec: SessionSpec): SessionSpec =>
    createSession(spec)
  )

  ipcMain.handle(IpcChannel.SESSION_COLOUR, (_event, sessionId: string, colour: number): void => {
    adoptSessionColour(sessionId, colour)
  })

  ipcMain.handle(IpcChannel.SESSION_REVERT, (_event, sessionId: string) => {
    const prompt = revertLastTurn(sessionId)
    announceHistory(sessionId, 'desktop')
    return prompt
  })

  ipcMain.handle(IpcChannel.SESSION_SNAPSHOT, (_event, sessionId: string) => {
    return sessionSnapshot(sessionId)
  })

  setOnSessionCreated((spec) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.SESSION_CREATED, spec)
      }
    }
  })

  setOnSessionTitled(announceSessionTitle)

  setRunningProbe(
    (sessionId) =>
      runForSession(sessionId) !== null
  )

  setOnSessionClosed((sessionId) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.SESSION_CLOSED, sessionId)
      }
    }
  })

  ipcMain.handle(IpcChannel.SESSION_CLOSE, (_event, sessionId: string): void => {
    deleteSession(sessionId)
  })

  ipcMain.handle(IpcChannel.AGENT_SEND, async (event, req: AgentRequest): Promise<{ runId: string; steered: boolean }> => {
    lastSender = event.sender
    return submitPrompt(req, approvals)
  })

  ipcMain.handle(IpcChannel.AGENT_CANCEL, (_event, runId: string): void => {
    cancelRun(runId)
  })
}
