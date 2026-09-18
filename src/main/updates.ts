import { APP_VERSION } from './version'
import { app, BrowserWindow } from 'electron'
import { notify } from './notify'
import path from 'node:path'
import { readdir, rm } from 'node:fs/promises'
import { IpcChannel } from '@shared/ipc'
import type { UpdateSettings, UpdateState } from '@shared/ipc'
import { loadPersistedSettings, savePersistedSettings } from './settings'
import { compareVersions, download, findLatest, install, parseSource, present } from './updater'
import type { Platform, UpdateAsset } from './updater'

/** How often a source is asked again while the app stays open. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1_000
/** The first check waits until start-up has settled. */
const FIRST_CHECK_MS = 20_000

/**
 * Updates come from exactly one place: the repository this app is released
 * from. It is not a setting, so nothing typed into an older build, or into
 * this one, can point the updater somewhere else.
 */
const OFFICIAL_REPO = 'fajrin77/anticode'

const DEFAULTS: UpdateSettings = { source: OFFICIAL_REPO, autoCheck: true, autoDownload: false }

let state: UpdateState | null = null
let asset: UpdateAsset | null = null
let downloaded: string | null = null
let timer: NodeJS.Timeout | null = null
let announcedVersion: string | null = null

function platform(): Platform {
  return { os: process.platform, arch: process.arch }
}

function workDirectory(): string {
  return path.join(app.getPath('userData'), 'updates')
}

/**
 * Old builds pile up here, one download per version the app ever pulled.
 * Keeping only what the current state needs, the rest goes: a staging copy
 * is tens or hundreds of megabytes the user never asked to keep.
 */
export async function pruneOldDownloads(keep?: string): Promise<void> {
  const dir = workDirectory()
  const entries = await readdir(dir).catch(() => [])
  await Promise.all(
    entries
      .filter((name) => name !== keep)
      .map((name) => rm(path.join(dir, name), { recursive: true, force: true }))
  )
}

function settings(): UpdateSettings {
  // The source is pinned, whatever an earlier install stored; only the two
  // switches follow what the user chose.
  const saved = loadPersistedSettings().updates
  return {
    source: OFFICIAL_REPO,
    autoCheck: saved?.autoCheck ?? DEFAULTS.autoCheck,
    autoDownload: saved?.autoDownload ?? DEFAULTS.autoDownload
  }
}

export function updateState(): UpdateState {
  if (state === null) {
    state = {
      ...settings(),
      status: 'idle',
      current: APP_VERSION,
      latest: null,
      notes: null,
      progress: null,
      error: null,
      checkedAt: null,
      // A dev run is Electron itself, not a bundle of anticode to replace.
      canInstall: app.isPackaged && ['darwin', 'win32', 'linux'].includes(process.platform)
    }
  }
  return state
}

function publish(patch: Partial<UpdateState>): UpdateState {
  state = { ...updateState(), ...patch }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IpcChannel.UPDATE_EVENT, state)
  }
  return state
}

function schedule(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  const current = updateState()
  if (!current.autoCheck || parseSource(current.source) === null) return
  timer = setTimeout(() => {
    void checkForUpdates().finally(schedule)
  }, current.checkedAt === null ? FIRST_CHECK_MS : CHECK_EVERY_MS)
  timer.unref?.()
}

/** Called once at start-up: nothing is asked until the first check is due. */
export function initUpdates(): void {
  // What earlier versions staged and never cleaned up goes now: the app is
  // running from its installed copy, so every file in the work directory is
  // an old download until proven otherwise.
  void pruneOldDownloads()
  updateState()
  schedule()
}

export function configureUpdates(patch: Partial<UpdateSettings>): UpdateState {
  // `source` is deliberately not accepted: the repository is fixed in this
  // build, so a stale value from an older install is overwritten here too.
  const next: UpdateSettings = { ...settings() }
  if (typeof patch.autoCheck === 'boolean') next.autoCheck = patch.autoCheck
  if (typeof patch.autoDownload === 'boolean') next.autoDownload = patch.autoDownload
  savePersistedSettings({ updates: next })
  const result = publish(next)
  schedule()
  return result
}

export async function checkForUpdates(): Promise<UpdateState> {
  const current = updateState()
  const source = parseSource(current.source)
  if (source === null) return publish({ status: 'idle', error: 'Set an update source first' })
  if (current.status === 'checking' || current.status === 'downloading') return current
  publish({ status: 'checking', error: null })
  try {
    const found = await findLatest(source, platform())
    const checkedAt = Date.now()
    if (found === null || compareVersions(found.version, current.current) <= 0) {
      asset = null
      return publish({ status: 'current', latest: found?.version ?? null, notes: null, checkedAt })
    }
    const same = asset?.version === found.version && downloaded !== null && (await present(downloaded))
    asset = found
    if (!same) downloaded = null
    publish({ status: same ? 'ready' : 'available', latest: found.version, notes: found.notes, checkedAt, progress: null })
    if (announcedVersion !== found.version) {
      announcedVersion = found.version
      notify('update', { title: 'anticode', body: `Version ${found.version} is available in Settings → Updates.` })
    }
    if (!same && updateState().autoDownload) return downloadUpdate()
    return updateState()
  } catch (error) {
    return publish({ status: 'error', error: (error as Error).message, checkedAt: Date.now() })
  }
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (asset === null) return publish({ status: 'error', error: 'Check for an update first' })
  if (updateState().status === 'downloading') return updateState()
  publish({ status: 'downloading', progress: 0, error: null })
  let last = 0
  try {
    downloaded = await download(asset, workDirectory(), (fraction) => {
      // Enough to move a bar, not enough to flood every window with messages.
      if (fraction - last >= 0.02 || fraction === 1) {
        last = fraction
        publish({ progress: fraction })
      }
    })
    // The previous build, if one was staged earlier, has no job left once a
    // newer one is in hand.
    await pruneOldDownloads(path.basename(downloaded))
    return publish({ status: 'ready', progress: 1 })
  } catch (error) {
    downloaded = null
    return publish({ status: 'error', progress: null, error: (error as Error).message })
  }
}

/**
 * Swaps the downloaded build in and quits; the helper opens the new version.
 * Only ever on the user's say-so, nothing calls this on its own.
 */
export async function installUpdate(): Promise<void> {
  const current = updateState()
  if (!current.canInstall) throw new Error('Only the packaged app can install updates')
  if (current.status !== 'ready' || downloaded === null) throw new Error('Download the update first')
  await install(downloaded, app.getPath('exe'), workDirectory(), platform(), process.pid)
  app.quit()
}
