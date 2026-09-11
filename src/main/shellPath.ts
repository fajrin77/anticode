import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

/*
 * An app opened from the Dock or Finder inherits launchd's short PATH, not the
 * one the user's shell builds — so `npx`, `uvx`, and anything from Homebrew or
 * nvm are not found. The login shell is asked once for its PATH; if it cannot
 * answer, the usual install locations are added to what there is.
 */

let resolved: Promise<string> | null = null

const COMMON = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

function fallback(): string {
  const current = (process.env['PATH'] ?? '').split(path.delimiter).filter((entry) => entry !== '')
  const extra = [...COMMON, path.join(homedir(), '.local/bin'), path.join(homedir(), '.cargo/bin'), path.join(homedir(), '.bun/bin')]
  return [...new Set([...current, ...extra])].join(path.delimiter)
}

export function shellPath(): Promise<string> {
  if (resolved !== null) return resolved
  if (process.platform === 'win32') {
    resolved = Promise.resolve(process.env['PATH'] ?? '')
    return resolved
  }
  resolved = new Promise((resolve) => {
    const shell = process.env['SHELL'] ?? '/bin/zsh'
    execFile(shell, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { timeout: 5_000, env: process.env }, (error, stdout) => {
      const found = /__PATH__(.*)__PATH__/s.exec(stdout ?? '')?.[1]
      if (error !== null || found === undefined || found.trim() === '') resolve(fallback())
      else resolve([...new Set([...found.split(path.delimiter), ...fallback().split(path.delimiter)])].join(path.delimiter))
    })
  })
  return resolved
}
