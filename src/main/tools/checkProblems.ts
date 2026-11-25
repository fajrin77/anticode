import { existsSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { defineTool } from './types'
import { resolveInWorkspace } from './workspace'
import { executeFile } from './runCommand'

function resolveNodeBin(root: string, binName: string, jsFallback: string[]): { file: string; prefixArgs: string[] } | null {
  if (process.platform === 'win32') {
    for (const rel of jsFallback) {
      const entry = path.join(root, 'node_modules', rel)
      if (existsSync(entry)) return { file: process.execPath, prefixArgs: [entry] }
    }
    const exe = path.join(root, 'node_modules', '.bin', `${binName}.exe`)
    if (existsSync(exe)) return { file: exe, prefixArgs: [] }
    return null
  }
  const bin = path.join(root, 'node_modules', '.bin', binName)
  return existsSync(bin) ? { file: bin, prefixArgs: [] } : null
}

const MAX_OUTPUT_CHARS = 8_000
const DEFAULT_TIMEOUT_MS = 120_000

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated (${text.length} characters total)`
    : text
}

function binExists(root: string, name: string, jsFallback: string[]): boolean {
  try {
    return resolveNodeBin(root, name, jsFallback) !== null
  } catch {
    return false
  }
}

function hasFile(root: string, name: string): boolean {
  try {
    return existsSync(path.join(root, name))
  } catch {
    return false
  }
}

interface Check {
  label: string
  run: () => Promise<string>
}

/**
 * Reads the project's own diagnostics back to the model: TypeScript errors
 * and ESLint findings for the workspace, using the project's own toolchain.
 * Nothing is ever downloaded — a checker that is not installed is skipped
 * with a note, never fetched. Read-only and low risk, so verifying after an
 * edit never costs an approval card.
 */
export const checkProblemsTool = defineTool({
  name: 'check_problems',
  description:
    'Check the workspace for code problems with its own toolchain: TypeScript ' +
    'errors (when tsconfig.json exists) and ESLint findings (when an ESLint ' +
    'config exists). Run it after editing code and fix what it reports before ' +
    'replying done. Checkers that are not installed are skipped, never downloaded.',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    path: z
      .string()
      .optional()
      .describe('Limit ESLint to one file or folder, relative to the workspace root; TypeScript always checks the whole project'),
    timeout_ms: z
      .number()
      .int()
      .min(10_000)
      .max(300_000)
      .default(DEFAULT_TIMEOUT_MS)
      .describe('Execution timeout in milliseconds')
  }),
  preview: async (input) => ({
    kind: 'text',
    subject: 'check_problems',
    detail: input.path ?? 'whole workspace'
  }),
  execute: async (input, context) => {
    const root = context.workspaceRoot
    let target = root
    if (input.path !== undefined) target = resolveInWorkspace(root, input.path)
    const checks: Check[] = []

    const tscJs = ['typescript/bin/tsc', 'typescript/lib/tsc.js']
    const eslintJs = ['eslint/bin/eslint.js']
    const tscBin = hasFile(root, 'tsconfig.json') ? resolveNodeBin(root, 'tsc', tscJs) : null
    if (tscBin !== null) {
      checks.push({
        label: 'TypeScript',
        run: async () => {
          const outcome = await executeFile(
            tscBin.file,
            [...tscBin.prefixArgs, '--noEmit', '-p', path.join(root, 'tsconfig.json')],
            root,
            input.timeout_ms,
            context.signal
          )
          if (outcome.timedOut) return 'TypeScript check timed out.'
          const text = `${outcome.stdout}\n${outcome.stderr}`.trim()
          return text === '' ? 'TypeScript: no problems found.' : `TypeScript:\n${text}`
        }
      })
    }

    const eslintConfig = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc'].some((name) => hasFile(root, name))
    const eslintBin = eslintConfig ? resolveNodeBin(root, 'eslint', eslintJs) : null
    if (eslintBin !== null) {
      checks.push({
        label: 'ESLint',
        run: async () => {
          const outcome = await executeFile(
            eslintBin.file,
            [...eslintBin.prefixArgs, '--', target],
            root,
            input.timeout_ms,
            context.signal
          )
          if (outcome.timedOut) return 'ESLint check timed out.'
          const text = `${outcome.stdout}\n${outcome.stderr}`.trim()
          return text === '' ? 'ESLint: no problems found.' : `ESLint:\n${text}`
        }
      })
    }

    if (checks.length === 0) {
      const hints: string[] = []
      if (!hasFile(root, 'tsconfig.json')) hints.push('no tsconfig.json')
      else if (!binExists(root, 'tsc', tscJs)) hints.push('TypeScript is not installed in the workspace')
      if (!eslintConfig) hints.push('no ESLint config')
      else if (!binExists(root, 'eslint', eslintJs)) hints.push('ESLint is not installed in the workspace')
      return `No checkers available (${hints.join('; ')}). Verify the change by reading the edited file back.`
    }

    const sections: string[] = []
    for (const check of checks) {
      context.signal.throwIfAborted()
      try {
        sections.push(await check.run())
      } catch (error) {
        sections.push(`${check.label} could not run: ${(error as Error).message}`)
      }
      // Killed mid-check (cancelled run): say so instead of reporting clean.
      context.signal.throwIfAborted()
    }
    return truncate(sections.join('\n\n'))
  }
})
