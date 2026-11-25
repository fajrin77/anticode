import { randomUUID } from 'node:crypto'
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RunSummary, SessionSpec } from '@shared/ipc'
import type { Message } from './providers/types'

export interface SavedSession {
  spec: SessionSpec
  messages: readonly Message[]
  summaries?: RunSummary[]
  web?: unknown
  choice?: unknown
  pinned?: boolean
  paused?: boolean
  pausedForRetry?: boolean
  rotationGroupId?: unknown
}

export const validSessionId = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)

function validRecord(value: unknown): value is SavedSession {
  const entry = value as SavedSession | null
  if (!entry?.spec) return false
  const { sessionId, mode, workspaceRoot } = entry.spec
  return validSessionId(sessionId) && (mode === 'code' || mode === 'chat') &&
    (workspaceRoot === null || typeof workspaceRoot === 'string') &&
    Array.isArray(entry.messages) && entry.messages.every(message =>
      message != null && ['user', 'assistant'].includes(message.role) && Array.isArray(message.content) &&
      message.content.every((block: unknown) => block !== null && typeof block === 'object' && 'type' in block))
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export class SessionStorage {
  private readonly directory: string
  private readonly legacy: string
  private readonly blocked = new Set<string>()
  private readonly dirty = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private writing: Promise<void> | undefined
  private ready = false
  warning: string | undefined

  constructor(root: string, private readonly snapshot: (id: string) => SavedSession | undefined) {
    this.directory = path.join(root, 'sessions')
    this.legacy = path.join(root, 'sessions.json')
  }

  private async recover<T>(target: string, decode: (value: unknown) => T | undefined): Promise<T | undefined> {
    for (const file of [target, `${target}.bak`]) {
      let raw: string
      try { raw = await readFile(file, 'utf8') } catch (error) {
        if (missing(error)) continue
        throw error
      }
      try {
        const value = decode(JSON.parse(raw))
        if (value !== undefined) return value
      } catch { /* An invalid payload is preserved for recovery. */ }
      this.warning = 'Some session history was damaged. The original files were preserved, and available backups were restored.'
      await rename(file, `${file.replace(/\.json(?:\.bak)?$/, '')}.corrupt-${Date.now()}-${randomUUID()}.json`)
    }
    return undefined
  }

  async load(): Promise<SavedSession[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if (!missing(error)) throw error
      return this.migrate()
    }
    const ids = new Set(names.flatMap(name => {
      const id = name.replace(/\.json(?:\.bak)?$/, '')
      return id !== name && validSessionId(id) ? [id] : []
    }))
    const records: SavedSession[] = []
    for (const id of ids) {
      try {
        const record = await this.recover(path.join(this.directory, `${id}.json`), value =>
          validRecord(value) && value.spec.sessionId === id ? value : undefined)
        if (record) records.push(record)
      } catch (error) {
        this.blocked.add(id)
        this.warning = 'Some session files could not be read. The app preserved them for recovery.'
        console.error('Could not read session history:', (error as Error).message)
      }
    }
    this.ready = true
    return records
  }

  private async migrate(): Promise<SavedSession[]> {
    let salvage: SavedSession[] = []
    const records = await this.recover(this.legacy, value => {
      if (!Array.isArray(value)) return undefined
      const valid = value.filter(validRecord)
      if (valid.length === value.length) return valid
      if (valid.length > salvage.length) salvage = valid
      return undefined
    }) ?? salvage
    const staging = `${this.directory}.migrating-${randomUUID()}`
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 })
      for (const record of records) {
        await writeFile(path.join(staging, `${record.spec.sessionId}.json`), JSON.stringify(record), { mode: 0o600 })
      }
      await rename(staging, this.directory)
      this.ready = true
      // Retain the original archive for rollback. Its presence never triggers a second migration.
      await link(this.legacy, `${this.legacy}.bak`).then(() => rm(this.legacy)).catch(() => undefined)
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      this.warning = 'The app could not migrate session history. It preserved the original archive.'
      console.error('Could not migrate session history:', (error as Error).message)
    }
    return records
  }

  mark(id: string): void {
    if (!this.ready || !validSessionId(id) || this.blocked.has(id)) return
    this.dirty.add(id)
    this.schedule()
  }

  async remove(id: string): Promise<void> {
    if (!this.ready || this.blocked.has(id)) throw new Error('This session could not be removed from storage')
    this.mark(id)
    await this.flush()
    if (this.dirty.has(id)) throw new Error('Could not remove this session from disk')
  }

  private schedule(): void {
    if (this.timer !== undefined || this.dirty.size === 0) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, 1500)
    this.timer.unref()
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    while (this.writing !== undefined) await this.writing
    if (this.dirty.size === 0) return
    const ids = [...this.dirty]
    this.dirty.clear()
    this.writing = this.write(ids).finally(() => { this.writing = undefined })
    await this.writing
    this.schedule()
  }

  private async write(ids: string[]): Promise<void> {
    for (const id of ids) {
      const target = path.join(this.directory, `${id}.json`)
      try {
        const record = this.snapshot(id)
        if (record === undefined) {
          await rm(`${target}.bak`, { force: true })
          await rm(target, { force: true })
          continue
        }
        await writeFile(`${target}.tmp`, JSON.stringify(record), { mode: 0o600 })
        await rm(`${target}.bak.tmp`, { force: true })
        const backedUp = await link(target, `${target}.bak.tmp`).then(() => true, error => {
          if (missing(error)) return false
          throw error
        })
        if (backedUp) await rename(`${target}.bak.tmp`, `${target}.bak`)
        await rename(`${target}.tmp`, target)
      } catch (error) {
        this.dirty.add(id)
        console.error('Could not save session history:', (error as Error).message)
      }
    }
  }
}
