import { spawn } from 'node:child_process'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'
import { isDestructiveCommand } from '../approval/policy'
import { noteWebUrl } from '../web'

const MAX_STREAM_CHARS = 10_000

/**
 * Dev servers announce themselves — "Local: http://localhost:5173/" — and that
 * line is the whole reason the browser pane exists, so it is picked out of the
 * output and opened without anyone having to ask for it.
 */
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d{2,5})?(?:\/\S*)?/i

function localServerUrl(output: string): string | null {
  const found = LOCAL_URL.exec(output)?.[0]
  if (found === undefined) return null
  // Trailing punctuation from prose around the URL, and a host nothing can
  // actually be fetched from.
  return found.replace(/[.,;:'")\]]+$/, '').replace('0.0.0.0', 'localhost')
}

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
    ? `${joined.slice(0, limit)}\n… output truncated (at least ${joined.length} characters)`
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
    signal.throwIfAborted()
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
    const capture = (chunks: string[]) => {
      let count = 0
      return (chunk: Buffer): void => {
        if (count >= MAX_STREAM_CHARS + 1) return
        const text = chunk.toString('utf8').slice(0, MAX_STREAM_CHARS + 1 - count)
        count += text.length
        chunks.push(text)
      }
    }
    child.stdout?.on('data', capture(stdout))
    child.stderr?.on('data', capture(stderr))

    // A backgrounded grandchild (dev servers, watchers) inherits the shell's
    // stdio pipes and can hold them open long after the shell itself is gone,
    // so the 'close' event never fires and the tool hangs until its timeout.
    // Once the shell has exited, only wait a short grace period for stragglers
    // before force-closing the streams.
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let streamGrace: NodeJS.Timeout | null = null
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal }
      streamGrace = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
      }, 1_500)
    })

    const cleanup = (): void => {
      clearTimeout(timer)
      if (streamGrace !== null) clearTimeout(streamGrace)
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
        code: exitInfo?.code ?? code,
        signal: exitInfo?.signal ?? closeSignal,
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

    const served = localServerUrl(`${outcome.stdout}\n${outcome.stderr}`)
    if (served !== null) noteWebUrl(context.sessionId, served)

    const sections = [`$ ${input.command}`, `[${status}]`]
    if (outcome.stdout.trim() !== '') sections.push(`stdout:\n${outcome.stdout.trimEnd()}`)
    if (outcome.stderr.trim() !== '') sections.push(`stderr:\n${outcome.stderr.trimEnd()}`)
    if (outcome.stdout.trim() === '' && outcome.stderr.trim() === '') {
      sections.push('(no output)')
    }
    return { text: sections.join('\n'), images: [], isError: outcome.code !== 0 || outcome.timedOut || context.signal.aborted }
  }
})
