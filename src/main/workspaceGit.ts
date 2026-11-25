import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { WorkspaceChanges } from '@shared/ipc'
import { resolveInWorkspace } from './tools/workspace'

function git(root: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' }
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const) delete (env as NodeJS.ProcessEnv)[key]
    const child = execFile('git', ['-c', 'core.fsmonitor=false', ...args],
      { cwd: root, timeout: 8_000, maxBuffer: 2 * 1024 ** 2, windowsHide: true, env },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Git output is too large to display' : 'Git could not complete this operation')))
        else resolve(stdout)
      })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(input)
  })
}

export async function workspaceChanges(root: string): Promise<WorkspaceChanges | null> {
  root = await realpath(root)
  const top = await git(root, ['rev-parse', '--show-toplevel']).then(value => value.trim(), () => null)
  if (top === null) return null
  const head = await git(root, ['status', '--porcelain=v1', '-b', '-z', '--no-renames', '--untracked-files=normal', '--', '.'])
  const [branch, ...entries] = head.split('\0')
  const files = entries.filter(entry => entry.length > 3).map(entry => {
    const status = entry.slice(0, 2)
    return { path: path.relative(root, path.join(top, entry.slice(3))), status }
  }).filter(entry => entry.path && !path.isAbsolute(entry.path) && !entry.path.split(path.sep).includes('..'))
  return { branch: branch?.slice(3) ?? '', dirty: files.length > 0, files: files.slice(0, 250) }
}

export async function workspacePatch(root: string, file: string): Promise<{ patch: string; revision: string; hunkRevert: boolean }> {
  const target = resolveInWorkspace(root, file)
  if (path.resolve(root) === target) throw new Error('Select a file')
  const patch = await git(root, ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '--', target])
  const hunkRevert = patch.startsWith('diff --git ') && !/^(?:new file mode|deleted file mode|old mode|GIT binary patch)/m.test(patch)
  return { patch, revision: createHash('sha256').update(patch).digest('hex'), hunkRevert }
}

export async function revertWorkspacePatch(
  root: string, file: string, revision: string, hunk: number | null, canApply: () => boolean
): Promise<boolean> {
  const current = await workspacePatch(root, file)
  if (!current.patch || current.revision !== revision) throw new Error('This file changed. Refresh its diff and try again.')
  let patch = current.patch
  if (hunk !== null) {
    const pieces = patch.split(/(?=^@@ )/m)
    if (!current.hunkRevert || pieces[hunk + 1] === undefined) throw new Error('This diff cannot be reverted by hunk.')
    patch = pieces[0] + pieces[hunk + 1]!
  }
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
  const target = resolveInWorkspace(root, file)
  const relative = path.relative(top, path.join(await realpath(root), path.relative(root, target))).split(path.sep).join('/')
  // Limit the patch application to the exact reviewed file, including when the workspace is a subdirectory.
  // Include patterns are git globs, so quote their metacharacters.
  const include = relative.replace(/[\\*?\[\]]/g, '\\$&')
  const args = ['apply', '--reverse', '--whitespace=nowarn', '--include=' + include]
  await git(top, [...args, '--check'], patch)
  if (!canApply()) throw new Error('Wait for the agent to finish in this workspace')
  const latest = await workspacePatch(root, file)
  if (latest.revision !== revision) throw new Error('This file changed. Refresh its diff and try again.')
  if (!canApply()) throw new Error('Wait for the agent to finish in this workspace')
  await git(top, args, patch)
  return true
}
