import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { isIgnoredEntry } from './tools/ignore'

/*
 * Checkpoints are the before-images of everything a run changed, kept on disk
 * so Revert still works after the app is reopened. Each belongs to the
 * transcript index of the prompt that started its run; reverting to a prompt
 * restores every checkpoint from that index on, newest first.
 *
 * Two ways in. A tool that names its target (edit, write, delete, Excel, Word,
 * PDF) is captured before it runs. A shell command names nothing, so the
 * workspace is scanned before and after it and whatever differs is recorded —
 * the before-images come from a mirror kept up to date with copy-on-write
 * clones, so an unchanged project costs a stat per file, not a copy.
 */

/** A scan that finds more than this gives up on tracking the command. */
const SCAN_MAX_FILES = 20_000
/** Larger files are left out of the command mirror, and reported as such. */
const MIRROR_MAX_FILE_BYTES = 20 * 1024 * 1024
/** The mirror stops growing past this; files beyond it are not restorable. */
const MIRROR_MAX_BYTES = 300 * 1024 * 1024
/** A folder a tool deletes is kept up to this many files. */
const DIRECTORY_MAX_FILES = 5_000
/** A single named file larger than this is not copied. */
const CAPTURE_MAX_FILE_BYTES = 200 * 1024 * 1024
/** Checkpoints older than this many prompts are dropped. */
const KEEP_TURNS = 40

type EntryKind =
  /** It was a file; `blob` holds its bytes. */
  | 'file'
  /** Nothing was there; restoring removes what is there now. */
  | 'absent'
  /** An empty folder was there; restoring recreates it. */
  | 'dir'
  /** The folder did not exist; restoring removes it once it is empty. */
  | 'new-dir'

interface Entry {
  path: string
  kind: EntryKind
  blob?: string
}

interface Manifest {
  version: 1
  id: string
  turn: number
  createdAt: number
  entries: Entry[]
  /** What could not be kept, so a restore can say so. */
  skipped: string[]
}

interface FileStat {
  mtimeMs: number
  size: number
}

export interface WorkspaceScan {
  files: Map<string, FileStat>
  dirs: Set<string>
  /** True when the scan stopped early; such a command is not tracked. */
  truncated: boolean
}

export interface RestoreReport {
  restored: number
  skipped: string[]
}

const CLONE = constants.COPYFILE_FICLONE

function sameStat(a: FileStat | undefined, b: FileStat | undefined): boolean {
  return a !== undefined && b !== undefined && a.mtimeMs === b.mtimeMs && a.size === b.size
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export class CheckpointStore {
  private current: Manifest | null = null
  private pendingTurn: number | null = null
  /** Path → the clone that holds its bytes as of the last scan. */
  private readonly mirror = new Map<string, FileStat & { blob: string }>()
  private mirrorBytes = 0

  constructor(
    private readonly dir: string,
    private readonly root: string
  ) {
    // The mirror only describes the files as this process last saw them; one
    // left by an earlier run of the app describes nothing trustworthy.
    rmSync(this.mirrorDir(), { recursive: true, force: true })
  }

  private mirrorDir(): string {
    return path.join(this.dir, '.mirror')
  }

  /** Every checkpoint on disk, oldest first. */
  private manifests(): Manifest[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    const found: Manifest[] = []
    for (const name of names) {
      if (name.startsWith('.')) continue
      try {
        const manifest = JSON.parse(readFileSync(path.join(this.dir, name, 'manifest.json'), 'utf8')) as Manifest
        if (manifest.version === 1 && typeof manifest.turn === 'number' && Array.isArray(manifest.entries)) found.push(manifest)
      } catch {
        // A half-written checkpoint from a crash restores nothing; drop it.
        rmSync(path.join(this.dir, name), { recursive: true, force: true })
      }
    }
    return found.sort((a, b) => a.turn - b.turn || a.createdAt - b.createdAt)
  }

  /** The turns that can still be reverted with their files. */
  turns(): number[] {
    return [...new Set(this.manifests().map((manifest) => manifest.turn))]
  }

  /**
   * A run starts at this transcript index. Nothing is written until the run
   * actually changes something — most turns never do.
   */
  begin(turn: number): void {
    this.current = null
    this.pendingTurn = turn
  }

  private open(): Manifest {
    if (this.current !== null) return this.current
    const turn = this.pendingTurn ?? 0
    // Before the new folder exists: without its manifest yet, a scan of the
    // store would take it for a half-written leftover.
    this.prune(turn)
    const id = `${String(turn).padStart(7, '0')}-${Date.now()}-${randomUUID().slice(0, 8)}`
    this.current = { version: 1, id, turn, createdAt: Date.now(), entries: [], skipped: [] }
    mkdirSync(path.join(this.dir, id, 'blobs'), { recursive: true })
    this.save()
    return this.current
  }

  private save(): void {
    if (this.current === null) return
    const target = path.join(this.dir, this.current.id, 'manifest.json')
    writeFileSync(`${target}.tmp`, JSON.stringify(this.current))
    renameSync(`${target}.tmp`, target)
  }

  private prune(turn: number): void {
    const turns = [...new Set(this.manifests().map((manifest) => manifest.turn).filter((value) => value < turn))]
    const drop = new Set(turns.slice(0, Math.max(0, turns.length - (KEEP_TURNS - 1))))
    for (const manifest of this.manifests()) {
      if (drop.has(manifest.turn)) rmSync(path.join(this.dir, manifest.id), { recursive: true, force: true })
    }
  }

  private has(relative: string): boolean {
    return this.current?.entries.some((entry) => entry.path === relative) === true
  }

  private blobPath(blob: string): string {
    return path.join(this.dir, this.current?.id ?? '', 'blobs', blob)
  }

  /**
   * Keeps what is at `target` right now, once per run, before a tool changes
   * it: a file's bytes, a folder's files (bounded), or the fact that nothing
   * was there. Targets outside the workspace are never touched by a tool, so
   * they are never kept either.
   */
  capture(target: string): void {
    const absolute = path.resolve(this.root, target)
    if (!isInside(this.root, absolute)) return
    const relative = path.relative(this.root, absolute)
    if (this.has(relative)) return
    let info: ReturnType<typeof lstatSync> | null = null
    try {
      info = lstatSync(absolute)
    } catch {
      info = null
    }
    const manifest = this.open()
    if (info === null) {
      manifest.entries.push({ path: relative, kind: 'absent' })
    } else if (info.isFile()) {
      this.keepFile(manifest, relative, absolute, info.size)
    } else if (info.isDirectory()) {
      this.keepDirectory(manifest, relative)
    }
    this.save()
  }

  private keepFile(manifest: Manifest, relative: string, absolute: string, size: number): void {
    if (size > CAPTURE_MAX_FILE_BYTES) {
      manifest.skipped.push(`${relative} (too large to keep)`)
      return
    }
    const blob = String(manifest.entries.length)
    try {
      copyFileSync(absolute, this.blobPath(blob), CLONE)
      manifest.entries.push({ path: relative, kind: 'file', blob })
    } catch {
      manifest.skipped.push(`${relative} (unreadable)`)
    }
  }

  private keepDirectory(manifest: Manifest, relative: string): void {
    const stack = [relative]
    let files = 0
    while (stack.length > 0) {
      const folder = stack.pop() as string
      if (!this.has(folder)) manifest.entries.push({ path: folder, kind: 'dir' })
      let children: string[]
      try {
        children = readdirSync(path.join(this.root, folder))
      } catch {
        continue
      }
      for (const name of children) {
        const child = path.join(folder, name)
        let info: ReturnType<typeof lstatSync>
        try {
          info = lstatSync(path.join(this.root, child))
        } catch {
          continue
        }
        if (info.isDirectory()) stack.push(child)
        else if (info.isFile() && !this.has(child)) {
          if (files >= DIRECTORY_MAX_FILES) {
            manifest.skipped.push(`${relative} (only the first ${DIRECTORY_MAX_FILES} files were kept)`)
            return
          }
          files += 1
          this.keepFile(manifest, child, path.join(this.root, child), info.size)
        }
      }
    }
  }

  /** Files and folders in the workspace, minus dependency and build folders. */
  async scan(): Promise<WorkspaceScan> {
    const files = new Map<string, FileStat>()
    const dirs = new Set<string>()
    const queue = ['']
    while (queue.length > 0) {
      const folder = queue.shift() as string
      let entries: Dirent[]
      try {
        entries = await readdir(path.join(this.root, folder), { withFileTypes: true })
      } catch {
        continue
      }
      const pending: Promise<void>[] = []
      for (const entry of entries) {
        const relative = folder === '' ? entry.name : path.join(folder, entry.name)
        if (entry.isDirectory()) {
          if (isIgnoredEntry(entry.name, true)) continue
          dirs.add(relative)
          queue.push(relative)
        } else if (entry.isFile()) {
          if (isIgnoredEntry(entry.name, false)) continue
          if (files.size + pending.length >= SCAN_MAX_FILES) return { files, dirs, truncated: true }
          pending.push(
            lstat(path.join(this.root, relative)).then(
              (info) => { files.set(relative, { mtimeMs: info.mtimeMs, size: info.size }) },
              () => undefined
            )
          )
        }
      }
      await Promise.all(pending)
    }
    return { files, dirs, truncated: false }
  }

  /**
   * Before a shell command: brings the mirror up to date with the workspace,
   * so every file the command might change has its before-image at hand.
   */
  async beforeCommand(): Promise<WorkspaceScan> {
    const scan = await this.scan()
    if (scan.truncated) return scan
    await mkdir(this.mirrorDir(), { recursive: true })
    for (const [relative, info] of this.mirror) {
      if (scan.files.has(relative)) continue
      this.mirror.delete(relative)
      this.mirrorBytes -= info.size
      await rm(path.join(this.mirrorDir(), info.blob), { force: true })
    }
    const stale = [...scan.files].filter(([relative, info]) => !sameStat(this.mirror.get(relative), info))
    for (let index = 0; index < stale.length; index += 32) {
      await Promise.all(stale.slice(index, index + 32).map(async ([relative, info]) => {
        const previous = this.mirror.get(relative)
        if (previous !== undefined) {
          this.mirror.delete(relative)
          this.mirrorBytes -= previous.size
          await rm(path.join(this.mirrorDir(), previous.blob), { force: true })
        }
        if (info.size > MIRROR_MAX_FILE_BYTES || this.mirrorBytes + info.size > MIRROR_MAX_BYTES) return
        const blob = randomUUID()
        this.mirrorBytes += info.size
        try {
          await copyFile(path.join(this.root, relative), path.join(this.mirrorDir(), blob), CLONE)
          this.mirror.set(relative, { ...info, blob })
        } catch {
          this.mirrorBytes -= info.size
        }
      }))
    }
    return scan
  }

  /**
   * After a shell command: whatever it created, changed, or deleted becomes
   * part of this run's checkpoint, with the before-image the mirror held.
   */
  async afterCommand(before: WorkspaceScan): Promise<void> {
    if (before.truncated) {
      this.open().skipped.push(`terminal changes (the workspace has more than ${SCAN_MAX_FILES} files)`)
      this.save()
      return
    }
    const after = await this.scan()
    if (after.truncated) {
      this.open().skipped.push(`terminal changes (the workspace has more than ${SCAN_MAX_FILES} files)`)
      this.save()
      return
    }
    const created = [...after.dirs].filter((folder) => !before.dirs.has(folder))
    const removed = [...before.dirs].filter((folder) => !after.dirs.has(folder))
    const changed = [...before.files].filter(([relative, info]) => !sameStat(after.files.get(relative), info))
    const added = [...after.files.keys()].filter((relative) => !before.files.has(relative))
    if (created.length + removed.length + changed.length + added.length === 0) return

    const manifest = this.open()
    // Restores run newest-first, so new folders go in first: they are removed
    // last, after the files inside them are gone — deepest first.
    for (const folder of created.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)) {
      if (!this.has(folder)) manifest.entries.push({ path: folder, kind: 'new-dir' })
    }
    for (const folder of removed) if (!this.has(folder)) manifest.entries.push({ path: folder, kind: 'dir' })
    for (const [relative, info] of changed) {
      if (this.has(relative)) continue
      const kept = this.mirror.get(relative)
      if (kept === undefined || !sameStat(kept, info)) {
        manifest.skipped.push(`${relative} (too large to keep)`)
        continue
      }
      const blob = String(manifest.entries.length)
      try {
        await rename(path.join(this.mirrorDir(), kept.blob), this.blobPath(blob))
        manifest.entries.push({ path: relative, kind: 'file', blob })
      } catch {
        manifest.skipped.push(`${relative} (could not be kept)`)
      }
      this.mirror.delete(relative)
      this.mirrorBytes -= kept.size
    }
    for (const relative of added) if (!this.has(relative)) manifest.entries.push({ path: relative, kind: 'absent' })
    this.save()
  }

  /**
   * Puts the files back as they were before the prompt at transcript index
   * `turn`, undoing every checkpoint from there on, newest first, and forgets
   * those checkpoints.
   */
  restoreFrom(turn: number): RestoreReport {
    const report: RestoreReport = { restored: 0, skipped: [] }
    const undone = this.manifests().filter((manifest) => manifest.turn >= turn).reverse()
    for (const manifest of undone) {
      for (const entry of [...manifest.entries].reverse()) {
        const target = path.join(this.root, entry.path)
        if (!isInside(this.root, target)) continue
        try {
          if (entry.kind === 'file' && entry.blob !== undefined) {
            const existing = existsSync(target) ? lstatSync(target) : null
            if (existing?.isDirectory() === true) rmSync(target, { recursive: true, force: true })
            mkdirSync(path.dirname(target), { recursive: true })
            copyFileSync(path.join(this.dir, manifest.id, 'blobs', entry.blob), target, CLONE)
          } else if (entry.kind === 'absent') {
            const existing = existsSync(target) ? lstatSync(target) : null
            if (existing !== null && !existing.isDirectory()) rmSync(target, { force: true })
            else if (existing?.isDirectory() === true) rmSync(target, { recursive: true, force: true })
          } else if (entry.kind === 'dir') {
            mkdirSync(target, { recursive: true })
          } else if (entry.kind === 'new-dir') {
            if (existsSync(target) && readdirSync(target).length === 0) rmdirSync(target)
          }
          report.restored += 1
        } catch {
          // A file another program holds open must not stop the rest.
          report.skipped.push(entry.path)
        }
      }
      report.skipped.push(...manifest.skipped)
      rmSync(path.join(this.dir, manifest.id), { recursive: true, force: true })
    }
    if (this.current !== null && this.current.turn >= turn) this.current = null
    // Restored files no longer match what the mirror remembers.
    for (const info of this.mirror.values()) rmSync(path.join(this.mirrorDir(), info.blob), { force: true })
    this.mirror.clear()
    this.mirrorBytes = 0
    return report
  }

  /** The session is gone; so are its checkpoints. */
  destroy(): void {
    rmSync(this.dir, { recursive: true, force: true })
    this.mirror.clear()
    this.mirrorBytes = 0
  }
}
