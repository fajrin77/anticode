import type { BrowserWindow } from 'electron'
import { IpcChannel } from '@shared/ipc'

/*
 * The app has two kinds of window now: the main one, and the small quick
 * capture panel. Anything that means "the app's window" — approvals, the
 * global shortcut, a notification being clicked — means the main one, so it
 * is named here instead of being taken as the first window in the list.
 */

let main: BrowserWindow | null = null
let opener: (() => BrowserWindow) | null = null

/** Called by createWindow, which is also how a closed main window comes back. */
export function setMainWindow(window: BrowserWindow, create: () => BrowserWindow): void {
  main = window
  opener = create
  window.on('closed', () => {
    if (main === window) main = null
  })
}

export function mainWindow(): BrowserWindow | null {
  return main !== null && !main.isDestroyed() ? main : null
}

/** The main window on screen and focused, made again if it was closed. */
export function showMainWindow(): BrowserWindow | null {
  let window = mainWindow()
  if (window === null && opener !== null) window = opener()
  if (window === null) return null
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return window
}

/**
 * Brings the main window up on a session: from the tray, a quick capture, or
 * a notification. A window still loading hears of it once it has loaded.
 */
export function focusSession(sessionId: string): void {
  const window = showMainWindow()
  if (window === null) return
  const send = (): void => window.webContents.send(IpcChannel.SESSION_FOCUS, sessionId)
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', send)
  else send()
}
