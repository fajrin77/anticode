import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CheckpointStore } from './checkpoints'

let root: string
let dir: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'anticode-cp-root-'))
  dir = await mkdtemp(path.join(tmpdir(), 'anticode-cp-store-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(dir, { recursive: true, force: true })
})

const at = (name: string): string => path.join(root, name)

describe('CheckpointStore', () => {
  it('writes nothing for a turn that changes nothing', () => {
    const store = new CheckpointStore(dir, root)
    store.begin(0)
    expect(store.turns()).toEqual([])
  })

  it('restores a named file and removes one that did not exist', async () => {
    await writeFile(at('a.txt'), 'before')
    const store = new CheckpointStore(dir, root)
    store.begin(0)
    store.capture('a.txt')
    store.capture('new.txt')
    await writeFile(at('a.txt'), 'after')
    await writeFile(at('new.txt'), 'made')

    const report = store.restoreFrom(0)
    expect(await readFile(at('a.txt'), 'utf8')).toBe('before')
    expect(existsSync(at('new.txt'))).toBe(false)
    expect(report.skipped).toEqual([])
    expect(store.turns()).toEqual([])
  })

  it('keeps the first before-image of a path within a run', async () => {
    await writeFile(at('a.txt'), 'one')
    const store = new CheckpointStore(dir, root)
    store.begin(0)
    store.capture('a.txt')
    await writeFile(at('a.txt'), 'two')
    store.capture('a.txt')
    await writeFile(at('a.txt'), 'three')
    store.restoreFrom(0)
    expect(await readFile(at('a.txt'), 'utf8')).toBe('one')
  })

  it('brings a deleted folder back with its files', async () => {
    await mkdir(at('lib/deep'), { recursive: true })
    await writeFile(at('lib/x.ts'), 'x')
    await writeFile(at('lib/deep/y.ts'), 'y')
    const store = new CheckpointStore(dir, root)
    store.begin(0)
    store.capture('lib')
    await rm(at('lib'), { recursive: true })
    store.restoreFrom(0)
    expect(await readFile(at('lib/x.ts'), 'utf8')).toBe('x')
    expect(await readFile(at('lib/deep/y.ts'), 'utf8')).toBe('y')
  })

  it('records what a shell command created, changed, and deleted', async () => {
    await writeFile(at('keep.txt'), 'keep')
    await writeFile(at('change.txt'), 'original')
    await writeFile(at('gone.txt'), 'doomed')
    const store = new CheckpointStore(dir, root)
    store.begin(0)
    const before = await store.beforeCommand()
    // What `mkdir -p gen/sub && echo … > gen/sub/out.txt && rm gone.txt` would do.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await writeFile(at('change.txt'), 'edited by the terminal')
    await rm(at('gone.txt'))
    await mkdir(at('gen/sub'), { recursive: true })
    await writeFile(at('gen/sub/out.txt'), 'generated')
    await store.afterCommand(before)

    store.restoreFrom(0)
    expect(await readFile(at('change.txt'), 'utf8')).toBe('original')
    expect(await readFile(at('gone.txt'), 'utf8')).toBe('doomed')
    expect(await readFile(at('keep.txt'), 'utf8')).toBe('keep')
    expect(existsSync(at('gen'))).toBe(false)
  })

  it('leaves dependency folders out of the scan', async () => {
    await mkdir(at('node_modules/pkg'), { recursive: true })
    const store = new CheckpointStore(dir, root)
    store.begin(0)
    const before = await store.beforeCommand()
    await writeFile(at('node_modules/pkg/index.js'), 'installed')
    await store.afterCommand(before)
    expect(store.turns()).toEqual([])
  })

  it('survives a restart: a new store on the same folder restores', async () => {
    await writeFile(at('a.txt'), 'before')
    const first = new CheckpointStore(dir, root)
    first.begin(3)
    first.capture('a.txt')
    await writeFile(at('a.txt'), 'after')

    const reopened = new CheckpointStore(dir, root)
    expect(reopened.turns()).toEqual([3])
    reopened.restoreFrom(3)
    expect(await readFile(at('a.txt'), 'utf8')).toBe('before')
  })

  it('restores every turn from the one reverted to, newest first', async () => {
    await writeFile(at('a.txt'), 'v0')
    const store = new CheckpointStore(dir, root)
    store.begin(0)
    store.capture('a.txt')
    await writeFile(at('a.txt'), 'v1')
    store.begin(2)
    store.capture('a.txt')
    await writeFile(at('a.txt'), 'v2')
    store.begin(4)
    store.capture('a.txt')
    await writeFile(at('a.txt'), 'v3')

    store.restoreFrom(2)
    expect(await readFile(at('a.txt'), 'utf8')).toBe('v1')
    expect(store.turns()).toEqual([0])
  })

  it('never reaches outside the workspace', async () => {
    const store = new CheckpointStore(dir, root)
    store.begin(0)
    store.capture('../outside.txt')
    expect(store.turns()).toEqual([])
    expect((await stat(dir)).isDirectory()).toBe(true)
  })
})
