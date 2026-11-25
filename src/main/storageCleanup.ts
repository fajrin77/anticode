import { app, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { CheckpointStore } from './checkpoints'
import { runForSession } from './runs'
import { validSessionId } from './sessionStorage'

const PREFIX = 'anticode-web-'
const CHECKPOINT_BUDGET = 2 * 1024 ** 3
const attached = new Set<string>()
let lastSweep = 0
let cleanup: Promise<{ bytes: number; checkpoints: number; browserPartitions: number }> | undefined

export function noteBrowserPartition(partition: string): void {
  if (partition.startsWith(`persist:${PREFIX}`)) attached.add(partition.slice(8))
}

export async function clearSessionBrowserData(id: string): Promise<void> {
  if (!validSessionId(id)) return
  const name = PREFIX + id
  if (!attached.has(name)) {
    await rm(path.join(app.getPath('userData'), 'Partitions', name), { recursive: true, force: true })
    return
  }
  const browser = session.fromPartition(`persist:${name}`)
  await Promise.all([browser.clearStorageData(), browser.clearCache(), browser.clearAuthCache()])
}

async function children(directory: string) {
  return readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
}

async function sizeOf(target: string): Promise<number> {
  const stat = await lstat(target).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (stat === null) return 0
  if (!stat.isDirectory()) return stat.size
  let total = 0
  for (const child of await children(target)) total += await sizeOf(path.join(target, child.name))
  return total
}

export function scheduleCheckpointCleanup(): void {
  if (Date.now() - lastSweep < 60_000) return
  void cleanStorage().catch(error => console.error('Could not prune checkpoints:', (error as Error).message))
}

export function cleanStorage(sessionIds?: () => string[]): Promise<{ bytes: number; checkpoints: number; browserPartitions: number }> {
  if (cleanup !== undefined) return sessionIds === undefined ? cleanup : cleanup.then(() => cleanStorage(sessionIds))
  lastSweep = Date.now()
  cleanup = sweep(sessionIds).finally(() => { cleanup = undefined })
  return cleanup
}

async function sweep(sessionIds?: () => string[]) {
  const root = app.getPath('userData')
  const result = { bytes: 0, checkpoints: 0, browserPartitions: 0 }
  const directory = path.join(root, 'checkpoints')
  let usage = 0
  const candidates: { id: string; name: string; folder: string; size: number; age: number }[] = []
  for (const row of await children(directory)) {
    if (row.isDirectory() && /^\.pruning-[a-f0-9-]+$/.test(row.name)) {
      await rm(path.join(directory, row.name), { recursive: true, force: true })
      continue
    }
    if (!row.isDirectory() || !validSessionId(row.name)) continue
    const folder = path.join(directory, row.name)
    for (const item of await children(folder)) {
      if (!item.isDirectory()) continue
      const target = path.join(folder, item.name)
      const size = await sizeOf(target)
      usage += size
      if (item.name === '.mirror') {
        candidates.push({ id: row.name, name: item.name, folder, size, age: -1 })
        continue
      }
      const match = /^\d+-(\d+)-[\da-f]+$/.exec(item.name)
      if (match) candidates.push({ id: row.name, name: item.name, folder, size, age: Number(match[1]) })
    }
  }
  for (const entry of candidates.sort((a, b) => a.age - b.age)) {
    if (usage <= CHECKPOINT_BUDGET && (sessionIds === undefined || entry.name !== '.mirror')) break
    if (runForSession(entry.id) !== null) continue
    const target = path.join(entry.folder, entry.name)
    // Detach synchronously so a run admitted during the unlink cannot use this data.
    const trash = path.join(directory, `.pruning-${randomUUID()}`)
    try { renameSync(target, trash) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (entry.name === '.mirror') CheckpointStore.forgetIdleMirror(entry.folder)
    else {
      CheckpointStore.notePruned(entry.folder, Number(entry.name.split('-')[0]))
      result.checkpoints++
    }
    await rm(trash, { recursive: true, force: true })
    usage -= entry.size
    result.bytes += entry.size
  }
  if (sessionIds === undefined) return result
  const partitions = path.join(root, 'Partitions')
  for (const row of await children(partitions)) {
    const id = row.name.startsWith(PREFIX) ? row.name.slice(PREFIX.length) : ''
    if (!row.isDirectory() || !validSessionId(id)) continue
    const size = await sizeOf(path.join(partitions, row.name))
    if (sessionIds().some(sessionId => sessionId.toLowerCase() === id.toLowerCase())) continue
    await clearSessionBrowserData(id)
    if (!attached.has(row.name)) result.bytes += size
    result.browserPartitions++
  }
  return result
}
