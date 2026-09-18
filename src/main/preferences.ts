import { BrowserWindow } from 'electron'
import { INSTRUCTIONS_MAX_CHARS, IpcChannel } from '@shared/ipc'
import type { AppPreferences } from '@shared/ipc'
import { loadPersistedSettings, savePersistedSettings } from './settings'

/*
 * Small app-wide choices made in Settings → General. Each one is applied by
 * whoever owns it — the tray, notifications — through a listener, so this
 * module only keeps and announces them.
 */

const DEFAULTS: AppPreferences = {
  tray: true,
  instructions: '',
  notifications: { enabled: true, complete: true, error: true, approval: true, question: true, update: true, sound: true, background: true }
}

type Listener = (next: AppPreferences, previous: AppPreferences) => void
const listeners: Listener[] = []

export function preferences(): AppPreferences {
  const saved = loadPersistedSettings().preferences ?? {}
  return { ...DEFAULTS, ...saved, notifications: { ...DEFAULTS.notifications, ...(saved.notifications ?? {}) } }
}

export function onPreferences(listener: Listener): void {
  listeners.push(listener)
}

/** Only known keys of the right type are taken; anything else is ignored. */
export function setPreferences(patch: Record<string, unknown>): AppPreferences {
  const previous = preferences()
  const next: AppPreferences = { ...previous }
  for (const key of Object.keys(DEFAULTS) as (keyof AppPreferences)[]) {
    const value = patch[key]
    if (key === 'notifications') continue
    if (value !== undefined && typeof value === typeof DEFAULTS[key]) (next as unknown as Record<string, unknown>)[key] = value
  }
  // Notification switches are merged one by one, so a patch names only what changed.
  const notifications = patch['notifications']
  if (notifications !== null && typeof notifications === 'object') {
    for (const [name, value] of Object.entries(notifications as Record<string, unknown>)) {
      if (name in DEFAULTS.notifications && typeof value === 'boolean') {
        next.notifications = { ...next.notifications, [name]: value }
      }
    }
  }
  if (next.instructions.length > INSTRUCTIONS_MAX_CHARS) {
    throw new Error(`Keep instructions under ${INSTRUCTIONS_MAX_CHARS.toLocaleString('en-US')} characters`)
  }
  savePersistedSettings({ preferences: next })
  for (const listener of listeners) listener(next, previous)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IpcChannel.PREFERENCES_UPDATED, next)
  }
  return next
}
