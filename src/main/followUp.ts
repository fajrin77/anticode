import { loadPersistedSettings, savePersistedSettings } from './settings'

/**
 * What a prompt sent while a run works does: ride along with the task
 * (steer) or wait in line for the next turn (queue). One switch, one home —
 * the persisted settings file — so the desktop chip and the phone chip tell
 * the same story instead of each keeping its own preference.
 */
let mode: 'steer' | 'queue' = loadPersistedSettings().followUpMode ?? 'steer'

export function followUpMode(): 'steer' | 'queue' {
  return mode
}

export function setFollowUpMode(next: 'steer' | 'queue'): void {
  mode = next
  savePersistedSettings({ followUpMode: next })
}
