import { app, shell, BrowserWindow, nativeImage, globalShortcut } from 'electron'
import type { WebContents } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { loadEnvFile } from './config'
import { cancelAllRuns } from './runs'
import { initPersistedState, persistSessions } from './runtime'
import { restoreRemoteServer } from './remote/server'
import { closeBrowser } from './browser'

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The browser pane beside the transcript is a <webview>; the guest gets
      // no preload and no Node of its own (see the guard in whenReady).
      webviewTag: true,
      // Required for ESM preload scripts; the renderer stays isolated from Node.
      sandbox: false
    }
  })

  window.on('ready-to-show', () => window.show())

  // The renderer sets the pane's src from a URL the agent reached, so it is
  // pinned down here rather than trusted: no preload, no Node, http(s) only.
  window.webContents.on('will-attach-webview', (event, preferences, params) => {
    delete preferences.preload
    preferences.nodeIntegration = false
    preferences.contextIsolation = true
    const source = String(params['src'] ?? '')
    if (source !== '' && !source.startsWith('http://') && !source.startsWith('https://')) {
      event.preventDefault()
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    // Only real web links go to the system browser; anything else (file:, custom
    // schemes) is dropped so renderer content cannot launch arbitrary handlers.
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

/**
 * A guest page in the browser pane is ordinary web content, so it is held to
 * ordinary web-content rules: no Node, no preload smuggled in through the tag's
 * attributes, and a link that wants a new window opens in the real browser
 * rather than a chromeless one inside the app.
 */
function containGuest(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
}

// Two instances would share one userData dir and fight over the remote port,
// so a second launch just focuses the first window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

void app.whenReady().then(() => {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window !== undefined) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })

  app.setAppUserModelId('com.anticode.app')

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') containGuest(contents)
  })


  // A packaged app takes its icon from the bundle; dev runs under Electron's
  // own identity, so point the dock at the real one.
  if (!app.isPackaged && process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(join(process.cwd(), 'build/icon.png'))
    if (!icon.isEmpty()) app.dock?.setIcon(icon)
  }
  loadEnvFile()
  initPersistedState()
  registerIpcHandlers()
  void restoreRemoteServer()
  createWindow()
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    let window = BrowserWindow.getAllWindows()[0]
    if (window === undefined) {
      createWindow()
      window = BrowserWindow.getAllWindows()[0]
    }
    if (window !== undefined) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  globalShortcut.unregisterAll()
  cancelAllRuns()
  persistSessions()
  void closeBrowser()
})
