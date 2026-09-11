import { BrowserWindow } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { AppPreferences } from '@shared/ipc'
import { loadPersistedSettings, savePersistedSettings } from './settings'

/*
 * Small app-wide choices made in Settings → General. Each one is applied by
 * whoever owns it — the tray, notifications — through a listener, so this
 * module only keeps and announces them.
 */

const DEFAULTS: AppPreferences = { tray: true }

type Listener = (next: AppPreferences, previous: AppPreferences) => void
const listeners: Listener[] = []

export function preferences(): AppPreferences {
  const saved = loadPersistedSettings().preferences ?? {}
  return { ...DEFAULTS, ...saved }
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
    if (value !== undefined && typeof value === typeof DEFAULTS[key]) (next as unknown as Record<string, unknown>)[key] = value
  }
  savePersistedSettings({ preferences: next })
  for (const listener of listeners) listener(next, previous)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IpcChannel.PREFERENCES_UPDATED, next)
  }
  return next
}
