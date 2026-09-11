import { BrowserWindow, Menu, nativeImage, screen, Tray } from 'electron'
import type { NativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { IpcChannel } from '@shared/ipc'
import type { QuickCapture } from '@shared/ipc'
import type { ApprovalGate } from './approval/types'
import { submitPrompt } from './prompts'
import { preferences } from './preferences'
import { createRemoteSession, getStatus, listSessionSummaries } from './runtime'
import { focusSession, showMainWindow } from './windows'

/*
 * The menu-bar icon (a tray icon elsewhere) and the quick capture panel it
 * opens. Quick capture is a prompt box that floats over whatever app is in
 * front: type, press Enter, and a new session starts working on it without
 * anticode having to come forward.
 */

export const QUICK_CAPTURE_SHORTCUT = 'CommandOrControl+Alt+Space'

let tray: Tray | null = null
let capture: BrowserWindow | null = null
let preload = ''
let rendererUrl: string | null = null
let rendererFile = ''

/**
 * A menu-bar glyph drawn in code: a rounded square with a prompt chevron
 * inside, as a macOS template image so the system tints it for light and dark
 * menu bars. 18 points, drawn at twice that for Retina.
 */
export function trayGlyph(scale = 2, shade = 0): Buffer {
  const size = 18 * scale
  const pixels = Buffer.alloc(size * size * 4)
  const stroke = 1.5 * scale
  const inset = 2 * scale
  const radius = 4 * scale
  const segment = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
    const dx = bx - ax
    const dy = by - ay
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      // Distance to the rounded square's edge.
      const half = size / 2 - inset
      const qx = Math.abs(px - size / 2) - (half - radius)
      const qy = Math.abs(py - size / 2) - (half - radius)
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
      const box = Math.abs(outside) - stroke / 2
      // The chevron: two strokes meeting at the middle right.
      const cx = size * 0.38
      const cy = size * 0.5
      const reach = size * 0.14
      const chevron = Math.min(
        segment(px, py, cx - reach * 0.5, cy - reach, cx + reach * 0.5, cy),
        segment(px, py, cx + reach * 0.5, cy, cx - reach * 0.5, cy + reach)
      ) - stroke / 2
      const underscore = segment(px, py, size * 0.52, size * 0.64, size * 0.66, size * 0.64) - stroke / 2
      const distance = Math.min(box, chevron, underscore)
      const alpha = Math.max(0, Math.min(1, 0.5 - distance))
      const offset = (y * size + x) * 4
      pixels[offset] = shade
      pixels[offset + 1] = shade
      pixels[offset + 2] = shade
      pixels[offset + 3] = Math.round(alpha * 255)
    }
  }
  return pixels
}

function trayImage(): NativeImage {
  if (process.platform === 'darwin') {
    const image = nativeImage.createFromBitmap(trayGlyph(2), { width: 36, height: 36, scaleFactor: 2 })
    image.setTemplateImage(true)
    return image
  }
  // Other trays do not tint, and a black glyph vanishes on a dark taskbar.
  return nativeImage.createFromBitmap(trayGlyph(2, 0xed), { width: 36, height: 36, scaleFactor: 2 })
}

function menu(): Menu {
  const recent = listSessionSummaries()
    .filter((session) => session.messageCount > 0)
    .slice(-6)
    .reverse()
  return Menu.buildFromTemplate([
    { label: 'Quick capture…', accelerator: QUICK_CAPTURE_SHORTCUT, click: () => showQuickCapture() },
    { label: 'Show anticode', click: () => showMainWindow() },
    { type: 'separator' },
    ...(recent.length === 0
      ? [{ label: 'No sessions yet', enabled: false }]
      : recent.map((session) => ({
          label: `${session.running ? '● ' : ''}${session.title.slice(0, 48)}${session.mode === 'chat' ? '' : ' · anticode'}`,
          click: () => focusSession(session.id)
        }))),
    { type: 'separator' },
    { label: 'Quit anticode', role: 'quit' as const }
  ])
}

/** Puts the icon up or takes it down, as Settings → General says. */
export function applyTray(): void {
  const wanted = preferences().tray
  if (!wanted) {
    tray?.destroy()
    tray = null
    return
  }
  if (tray !== null) return
  tray = new Tray(trayImage())
  tray.setToolTip('anticode')
  // Built on every open, so the recent sessions and their state are current.
  const open = (): void => tray?.popUpContextMenu(menu())
  tray.on('click', open)
  tray.on('right-click', open)
}

/** Where the renderer lives, so the capture panel loads the same bundle. */
export function configureQuickCapture(options: { preload: string; url: string | null; file: string }): void {
  preload = options.preload
  rendererUrl = options.url
  rendererFile = options.file
}

function captureWindow(): BrowserWindow {
  if (capture !== null && !capture.isDestroyed()) return capture
  const mac = process.platform === 'darwin'
  capture = new BrowserWindow({
    width: 640,
    height: 176,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: mac,
    backgroundColor: mac ? '#00000000' : '#1f1f1f',
    ...(mac ? { vibrancy: 'hud' as const, visualEffectState: 'active' as const } : {}),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  capture.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Like Spotlight: clicking anywhere else puts it away.
  capture.on('blur', () => capture?.hide())
  capture.on('closed', () => { capture = null })
  if (rendererUrl !== null) void capture.loadURL(`${rendererUrl}#quick`)
  else void capture.loadFile(rendererFile, { hash: 'quick' })
  return capture
}

/** Shows the panel over whatever is in front, on the display the cursor is on. */
export function showQuickCapture(): void {
  const window = captureWindow()
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const [width = 640] = window.getSize()
  window.setPosition(
    Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    Math.round(display.workArea.y + display.workArea.height * 0.22)
  )
  const reveal = (): void => {
    window.show()
    window.focus()
    window.webContents.send(IpcChannel.QUICK_OPENED)
  }
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', reveal)
  else reveal()
}

export function hideQuickCapture(): void {
  capture?.hide()
}

/**
 * A new session, started on the prompt the panel sent: antichat, or anticode
 * in the folder last picked in the Projects screen. The panel goes away; the
 * main window comes up only when asked to.
 */
export async function sendQuickCapture(input: QuickCapture, gate: ApprovalGate): Promise<string> {
  const text = typeof input?.text === 'string' ? input.text.trim() : ''
  if (text === '') throw new Error('Type something to send')
  const mode = input.mode === 'code' ? 'code' : 'chat'
  const status = getStatus()
  const root = mode === 'code' ? status.workspaceRoot : null
  if (mode === 'code' && root === null) throw new Error('Pick a project folder in anticode first')
  if (!status.providerReady) throw new Error(status.blockedReason ?? 'No model is ready')
  const sessionId = createRemoteSession(mode, root)
  await submitPrompt({ sessionId, runId: randomUUID(), prompt: text, attachmentIds: [] }, gate)
  hideQuickCapture()
  if (input.open === true) focusSession(sessionId)
  return sessionId
}
