import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { ToolError } from './types'

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate)
  if (relative === '') return
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ToolError(`Access outside the workspace is denied: ${candidate}`)
  }
}

function nearestExisting(target: string): string {
  let probe = target
  while (!existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) return probe
    probe = parent
  }
  return probe
}

/**
 * Resolves a model-supplied path against the workspace root and refuses anything
 * that escapes it. The second check runs after symlink resolution, so a link
 * inside the workspace cannot be used to reach files outside it.
 */
export function resolveInWorkspace(root: string, target: string): string {
  const absolute = path.resolve(root, target)
  assertInside(root, absolute)
  assertInside(realpathSync(root), realpathSync(nearestExisting(absolute)))
  return absolute
}
