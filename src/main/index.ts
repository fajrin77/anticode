import { app, shell, BrowserWindow, nativeImage } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { loadEnvFile } from './config'
import { initPersistedState } from './runtime'
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
      // Required for ESM preload scripts; the renderer stays isolated from Node.
      sandbox: false
    }
  })

  window.on('ready-to-show', () => window.show())

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

void app.whenReady().then(() => {
  app.setAppUserModelId('com.anticode.app')

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void closeBrowser()
})
