import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { shellPath } from './shellPath'
import { isIgnoredEntry } from './tools/ignore'
import { resolveInWorkspace } from './tools/workspace'

export async function searchWorkspaceFiles(root: string, query: string): Promise<string[]> {
  const needle = query.toLowerCase().replaceAll('\\', '/')
  const pending = ['']
  const matches: string[] = []
  let checked = 0
  for (let index = 0; index < pending.length && matches.length < 80 && checked < 20_000; index++) {
    const folder = pending[index]!
    const directory = resolveInWorkspace(root, folder)
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (++checked > 20_000 || matches.length >= 80) break
      if (isIgnoredEntry(entry.name, entry.isDirectory()) || /[\x00-\x1f]/.test(entry.name)) continue
      const name = folder ? folder + '/' + entry.name : entry.name
      if (entry.isDirectory()) pending.push(name)
      else if (entry.isFile() && name.toLowerCase().includes(needle)) matches.push(name)
    }
  }
  return matches.sort((a, b) => {
    const stem = (file: string) => path.posix.basename(file).toLowerCase().startsWith(needle)
    return Number(stem(b)) - Number(stem(a)) || a.length - b.length || a.localeCompare(b)
  }).slice(0, 12)
}

export async function openInEditor(root: string, file: string, editor: 'code' | 'cursor', line: number): Promise<void> {
  const target = resolveInWorkspace(root, file)
  if (!(await stat(target)).isFile()) throw new Error('Select a file in this workspace')
  const macName = editor === 'code' ? 'Visual Studio Code' : 'Cursor'
  const winFolder = editor === 'code' ? 'Microsoft VS Code' : 'cursor'
  const winExe = editor === 'code' ? 'Code.exe' : 'Cursor.exe'
  const locations = process.platform === 'darwin'
    ? ['/Applications', path.join(homedir(), 'Applications')].map(base =>
        path.join(base, macName + '.app', 'Contents', 'Resources', 'app', 'bin', editor))
    : process.platform === 'win32'
      ? [path.join(process.env['LOCALAPPDATA'] ?? homedir(), 'Programs'), process.env['ProgramFiles'] ?? '']
        .filter(path.isAbsolute).map(base => path.join(base, winFolder, winExe))
      : (await shellPath()).split(path.delimiter).filter(path.isAbsolute).map(base => path.join(base, editor))
  for (const executable of locations) {
    try { await access(executable, constants.X_OK) } catch { continue }
    await new Promise<void>((resolve, reject) => {
      execFile(executable, ['--goto', target + ':' + line], { cwd: homedir(), timeout: 10_000, windowsHide: true },
        error => { if (error) reject(new Error('The editor could not open this file')); else resolve() })
    })
    return
  }
  throw new Error(macName + ' could not be found on this computer')
}
