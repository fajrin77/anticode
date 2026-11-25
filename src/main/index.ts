import { app, shell, BrowserWindow, nativeImage, globalShortcut, session } from 'electron'
import type { WebContents } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { startScheduler, stopScheduler } from './scheduler'
import { loadEnvFile } from './config'
import { cancelAllRuns } from './runs'
import { initPersistedState, flushPersistedSessions } from './runtime'
import { flushRotationUsage } from './rotation'
import { flushAccountUsage } from './auth/sharing'
import { closeRemoteServer, restoreRemoteServer } from './remote/server'
import { closeBrowser } from './browser'
import { initUpdates } from './updates'
import { mainWindow, setMainWindow, showMainWindow } from './windows'
import { applyTray, configureQuickCapture, destroyTray, QUICK_CAPTURE_SHORTCUT, showQuickCapture } from './tray'
import { onPreferences, preferences } from './preferences'
import { closeMcp, initMcp, mcpTools } from './mcp/manager'
import { accountConnectorTools, closeAccountConnectors, initAccountConnectors } from './mcp/accountConnectors'
import { closePlugins, initPlugins, pluginTools } from './plugins'
import { setExternalTools } from './tools'
import { warmPdfParser } from './tools/pdf'

function createWindow(): BrowserWindow {
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
    preferences.sandbox = true
    preferences.webSecurity = true
    preferences.allowRunningInsecureContent = false
    preferences.experimentalFeatures = false
    const source = String(params['src'] ?? '')
    if (source !== '' && !source.startsWith('http://') && !source.startsWith('https://')) {
      event.preventDefault()
    }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  window.webContents.on('will-navigate', (event, url) => {
    const allowedDev = !app.isPackaged && devServerUrl ? url.startsWith(devServerUrl) : false
    const allowedFile = url.startsWith('file://')
    if (!allowedDev && !allowedFile) {
      event.preventDefault()
      if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
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

  if (!app.isPackaged && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  setMainWindow(window, createWindow)
  // Without a tray icon to come back through, closing the window on Windows
  // and Linux means quitting, the hidden capture panel must not keep it alive.
  window.on('closed', () => {
    if (process.platform !== 'darwin' && !preferences().tray) app.quit()
  })
  return window
}

/**
 * A guest page in the browser pane is ordinary web content, so it is held to
 * ordinary web-content rules: no Node, no preload smuggled in through the tag's
 * attributes, and a link that wants a new window opens in the real browser
 * rather than a chromeless one inside the app.
 */
function containGuest(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://') && !url.startsWith('https://') && url !== 'about:blank') {
      event.preventDefault()
    }
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
}

// Two instances would share one userData dir and fight over the remote port,
// so a second launch just focuses the first window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void app.whenReady().then(async () => {
    app.on('second-instance', () => {
      showMainWindow()
    })

    app.setAppUserModelId('com.anticode.app')

    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      if (wc.getType() === 'webview') {
        callback(false)
        return
      }
      callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write')
    })

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
    await initPersistedState()
    registerIpcHandlers()
    startScheduler()
    void restoreRemoteServer()
    initUpdates()
    // MCP servers start in the background; their tools join anticode sessions
    // as each one becomes ready.
    // Hosted connectors (ChatGPT apps, claude.ai connectors) follow the account
    // the session runs on, alongside the MCP servers set up in Settings.
    setExternalTools((providerId) => [...mcpTools(), ...pluginTools(), ...accountConnectorTools(providerId)])
    initMcp()
    initPlugins()
    initAccountConnectors()
    configureQuickCapture({
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      url: !app.isPackaged && process.env['ELECTRON_RENDERER_URL'] ? process.env['ELECTRON_RENDERER_URL'] : null,
      file: join(import.meta.dirname, '../renderer/index.html')
    })
    createWindow()
    applyTray()
    // The PDF stack cold-loads for seconds; warm it once startup has settled
    // so the first real read does not stall the session that asked for it.
    warmPdfParser()
    onPreferences((next, previous) => {
      if (next.tray !== previous.tray) applyTray()
    })
    // Taken already by another app, the tray menu still opens the panel, but
    // say so, or the shortcut silently never works and nobody knows why.
    if (!globalShortcut.register('CommandOrControl+Shift+Space', () => showMainWindow())) {
      console.warn('[anticode] CommandOrControl+Shift+Space is taken by another app, the tray menu still opens the window.')
    }
    if (!globalShortcut.register(QUICK_CAPTURE_SHORTCUT, () => showQuickCapture())) {
      console.warn(`[anticode] ${QUICK_CAPTURE_SHORTCUT} is taken by another app, quick capture is still reachable from the tray.`)
    }
    // Test harnesses have no menu bar to click; they open the panel through this.
    if (process.env['ANTICODE_TEST_HOOKS'] === '1') Object.assign(globalThis, { anticodeTest: { showQuickCapture } })

    app.on('activate', () => {
      // The capture panel is a window too; only the main one counts here.
      if (mainWindow() === null) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !preferences().tray) app.quit()
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  globalShortcut.unregisterAll()
  stopScheduler()
  destroyTray()
  cancelAllRuns()
  flushPersistedSessions()
  flushRotationUsage()
  flushAccountUsage()
  const teardown = Promise.allSettled([
    closeRemoteServer(),
    closeBrowser(),
    closeMcp(),
    closeAccountConnectors(),
    closePlugins()
  ])
  const deadline = new Promise((resolve) => setTimeout(resolve, 3_000))
  void Promise.race([teardown, deadline]).finally(() => app.exit(0))
})
