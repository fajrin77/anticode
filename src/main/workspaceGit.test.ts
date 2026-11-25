import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { revertWorkspacePatch, workspaceChanges, workspacePatch } from './workspaceGit'

it('reviews and reverts one unstaged hunk inside a nested workspace while preserving the staged index', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'anticode-workspace-git-'))
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const nested = path.join(root, 'nested')
  const name = 'notes [2026].txt'
  const file = path.join(nested, name)
  const original = ['before', ...Array.from({ length: 12 }, (_, i) => 'line ' + i), 'last'].join('\n') + '\n'
  try {
    git('init', '-q')
    await mkdir(nested)
    await writeFile(file, original)
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture')
    const staged = original.replace('line 6', 'staged')
    await writeFile(file, staged)
    git('add', '.')
    const unstaged = staged.replace('before', 'after').replace('last', 'new last')
    await writeFile(file, unstaged)
    expect(await workspaceChanges(nested)).toMatchObject({ dirty: true, files: [{ path: name, status: 'MM' }] })
    const diff = await workspacePatch(nested, name)
    expect(diff.hunkRevert).toBe(true)
    await expect(revertWorkspacePatch(nested, name, diff.revision, 0, () => false)).rejects.toThrow('finish')
    await revertWorkspacePatch(nested, name, diff.revision, 0, () => true)
    expect(await readFile(file, 'utf8')).toBe(staged.replace('last', 'new last'))
    expect(git('show', ':nested/' + name)).toBe(staged)
    await expect(revertWorkspacePatch(nested, name, diff.revision, null, () => true)).rejects.toThrow('changed')
    const remaining = await workspacePatch(nested, name)
    await revertWorkspacePatch(nested, name, remaining.revision, null, () => true)
    expect(await readFile(file, 'utf8')).toBe(staged)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
