import { loadPersistedSettings, savePersistedSettings } from './settings'

/** Exact provider/model evidence only; no guessed aliases or billing fallback. */
export function unavailableRoute(provider: string, model: string): string | null {
  const mark = loadPersistedSettings().unavailableRoutes?.[provider]?.[model]
  return mark && Date.now() - mark.since < 24 * 60 * 60_000 ? mark.reason : null
}

export function markRetiredRoute(provider: string, model: string): void {
  const all = loadPersistedSettings().unavailableRoutes ?? {}
  savePersistedSettings({ unavailableRoutes: { ...all, [provider]: { ...all[provider], [model]: {
    reason: 'Rute ini sudah dihentikan oleh provider dan dilewati selama 24 jam. Pilih model lain yang tersedia.', since: Date.now()
  } } } })
}

