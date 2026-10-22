import { loadPersistedSettings, savePersistedSettings } from '../settings'

/** One-time migration keeps only the previously selected provider visible. */
export function composerProviders(): Record<string, boolean> {
  const settings = loadPersistedSettings()
  if (settings.composerProviders !== undefined) return settings.composerProviders
  const initial = settings.provider && settings.provider !== 'rotate' ? { [settings.provider]: true } : {}
  savePersistedSettings({ composerProviders: initial })
  return initial
}

export function setComposerVisibility(id: string, visible: boolean): void {
  setComposerGroupVisibility([id], visible)
}
export function setComposerGroupVisibility(ids: string[], visible: boolean): void {
  savePersistedSettings({ composerProviders: { ...composerProviders(), ...Object.fromEntries(ids.map(id => [id, visible])) } })
}
