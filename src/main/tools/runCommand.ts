import { spawn } from 'node:child_process'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'
import { isDestructiveCommand } from '../approval/policy'

const MAX_STREAM_CHARS = 10_000

interface CommandOutcome {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
}

function collect(chunks: string[], limit: number): string {
  const joined = chunks.join('')
  return joined.length > limit
    ? `${joined.slice(0, limit)}\n… output truncated (${joined.length} characters total)`
    : joined
}

/**
 * Killing only the shell leaves its children — dev servers, test runners —
 * running as orphans. The child gets its own process group (POSIX) so one
 * signal reaches everything it spawned; Windows walks the tree via taskkill.
 */
function execute(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<CommandOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      detached: process.platform !== 'win32'
    })

    let timedOut = false
    const killTree = (): void => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
        } else {
          process.kill(-child.pid, 'SIGKILL')
        }
      } catch {
        // The group is already gone.
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)
    const onAbort = (): void => killTree()
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })

    const stdout: string[] = []
    const stderr: string[] = []
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')))

    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }

    child.on('error', (error) => {
      cleanup()
      reject(error)
    })
    child.on('close', (code, closeSignal) => {
      cleanup()
      resolve({
        stdout: collect(stdout, MAX_STREAM_CHARS),
        stderr: collect(stderr, MAX_STREAM_CHARS),
        code,
        signal: closeSignal,
        timedOut
      })
    })
  })
}

export const runCommandTool = defineTool({
  name: 'run_command',
  description:
    'Run a shell command inside the workspace and return stdout, stderr, and the exit code. ' +
    'The working directory is always confined to the workspace and every command has a timeout.',
  readOnly: false,
  risk: (input) => (isDestructiveCommand(input.command) ? 'high' : 'medium'),
  preview: async (input) => ({
    kind: 'command',
    subject: input.cwd === '.' ? 'workspace root' : input.cwd,
    detail: `$ ${input.command}\n\ncwd: ${input.cwd}\ntimeout: ${input.timeout_ms} ms`
  }),
  schema: z.object({
    command: z.string().min(1).describe('The shell command to run'),
    cwd: z
      .string()
      .default('.')
      .describe('Working directory relative to the workspace root'),
    timeout_ms: z
      .number()
      .int()
      .min(1000)
      .max(600_000)
      .default(120_000)
      .describe('Execution timeout in milliseconds')
  }),
  execute: async (input, context) => {
    const cwd = resolveInWorkspace(context.workspaceRoot, input.cwd)

    let outcome: CommandOutcome
    try {
      outcome = await execute(input.command, cwd, input.timeout_ms, context.signal)
    } catch (error) {
      if (context.signal.aborted) throw new ToolError('Command cancelled by the user')
      throw new ToolError(`Failed to run command: ${(error as Error).message}`)
    }

    const status = outcome.timedOut
      ? `killed after ${input.timeout_ms} ms`
      : `exit code ${outcome.code ?? 'unknown'}`

    const sections = [`$ ${input.command}`, `[${status}]`]
    if (outcome.stdout.trim() !== '') sections.push(`stdout:\n${outcome.stdout.trimEnd()}`)
    if (outcome.stderr.trim() !== '') sections.push(`stderr:\n${outcome.stderr.trimEnd()}`)
    if (outcome.stdout.trim() === '' && outcome.stderr.trim() === '') {
      sections.push('(no output)')
    }
    return sections.join('\n')
  }
})
