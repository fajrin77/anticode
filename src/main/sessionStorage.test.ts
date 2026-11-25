import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SessionStorage } from './sessionStorage'
import type { SavedSession } from './sessionStorage'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

function record(id: string, text = id): SavedSession {
  return { spec: { sessionId: id, mode: 'chat', workspaceRoot: null }, messages: [{ role: 'user', content: [{ type: 'text', text }] }] }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'anticode-session-storage-'))
  dirs.push(root)
  const records = new Map<string, SavedSession>()
  return { root, records, storage: new SessionStorage(root, id => records.get(id)) }
}

it('migrates the legacy archive, updates only dirty sessions, and never resurrects a deleted session', async () => {
  const { root, records, storage } = await fixture()
  const legacy = JSON.stringify([record('first'), record('second')])
  await writeFile(path.join(root, 'sessions.json'), legacy)
  expect(await storage.load()).toEqual([record('first'), record('second')])
  expect(await readFile(path.join(root, 'sessions.json.bak'), 'utf8')).toBe(legacy)
  records.set('first', record('first', 'new text'))
  storage.mark('first')
  await storage.flush()
  expect(await readdir(path.join(root, 'sessions'))).toEqual(['first.json', 'first.json.bak', 'second.json'])
  expect(await readFile(path.join(root, 'sessions', 'second.json'), 'utf8')).toBe(JSON.stringify(record('second')))
  records.delete('first')
  storage.mark('first')
  await storage.flush()
  expect(await new SessionStorage(root, () => undefined).load()).toEqual([record('second')])
})

it('quarantines an invalid legacy archive, restores its backup, and accepts future writes', async () => {
  const { root, records, storage } = await fixture()
  await writeFile(path.join(root, 'sessions.json'), 'bad archive')
  await writeFile(path.join(root, 'sessions.json.bak'), JSON.stringify([record('first')]))
  expect(await storage.load()).toEqual([record('first')])
  const quarantine = (await readdir(root)).find(name => name.startsWith('sessions.corrupt-'))!
  expect(await readFile(path.join(root, quarantine), 'utf8')).toBe('bad archive')
  records.set('second', record('second'))
  storage.mark('second')
  await storage.flush()
  expect(await new SessionStorage(root, () => undefined).load()).toEqual([record('first'), record('second')])
})

it('restores an individual backup without replacing the quarantined original or other sessions', async () => {
  const { root, records, storage } = await fixture()
  await storage.load()
  records.set('first', record('first'))
  records.set('second', record('second'))
  storage.mark('first')
  storage.mark('second')
  await storage.flush()
  records.set('first', record('first', 'second version'))
  storage.mark('first')
  await storage.flush()
  const directory = path.join(root, 'sessions')
  await rm(path.join(directory, 'first.json'))
  await writeFile(path.join(directory, 'first.json'), '{}')
  expect(await new SessionStorage(root, () => undefined).load()).toEqual([record('first'), record('second')])
  const quarantine = (await readdir(directory)).find(name => name.startsWith('first.corrupt-'))!
  expect(await readFile(path.join(directory, quarantine), 'utf8')).toBe('{}')
})
