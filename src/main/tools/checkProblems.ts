import { existsSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { defineTool } from './types'
import { resolveInWorkspace } from './workspace'
import { execute } from './runCommand'

const MAX_OUTPUT_CHARS = 8_000
const DEFAULT_TIMEOUT_MS = 120_000

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated (${text.length} characters total)`
    : text
}

function binExists(root: string, name: string): boolean {
  try {
    return existsSync(path.join(root, 'node_modules', '.bin', name))
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

    if (hasFile(root, 'tsconfig.json') && binExists(root, 'tsc')) {
      checks.push({
        label: 'TypeScript',
        run: async () => {
          const outcome = await execute(
            `${JSON.stringify(path.join(root, 'node_modules', '.bin', 'tsc'))} --noEmit -p ${JSON.stringify(path.join(root, 'tsconfig.json'))}`,
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
    if (eslintConfig && binExists(root, 'eslint')) {
      checks.push({
        label: 'ESLint',
        run: async () => {
          const outcome = await execute(
            `${JSON.stringify(path.join(root, 'node_modules', '.bin', 'eslint'))} ${JSON.stringify(target)}`,
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
      else if (!binExists(root, 'tsc')) hints.push('TypeScript is not installed in the workspace')
      if (!eslintConfig) hints.push('no ESLint config')
      else if (!binExists(root, 'eslint')) hints.push('ESLint is not installed in the workspace')
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
