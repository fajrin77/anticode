import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'
import { isDestructiveCommand } from '../approval/policy'
import { noteWebAutoOpen, noteWebUrl } from '../web'
import { anticodeEnvKeys } from '../config'

const MAX_STREAM_CHARS = 10_000
const HEAD_CHARS = 3_800
const TAIL_CHARS = 5_800

/**
 * Dev servers announce themselves, "Local: http://localhost:5173/", and that
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

export interface CommandOutcome {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
}

function sanitizedEnv(): NodeJS.ProcessEnv {
  const hidden = anticodeEnvKeys()
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (hidden.has(key) || /^ANTICODE_.*(SECRET|TOKEN|KEY)$/i.test(key)) continue
    env[key] = value
  }
  return env
}

interface StreamBuffer {
  head: string
  tail: string
  total: number
}

function formatBuffer(buf: StreamBuffer): string {
  if (buf.total <= MAX_STREAM_CHARS) return buf.head + buf.tail
  const omitted = buf.total - buf.head.length - buf.tail.length
  return `${buf.head}\n… output truncated (${omitted} of ${buf.total} characters omitted) …\n${buf.tail}`
}

function runSpawn(
  launch: () => ReturnType<typeof spawn>,
  timeoutMs: number,
  signal: AbortSignal
): Promise<CommandOutcome> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const child = launch()

    let timedOut = false
    let killEscalation: NodeJS.Timeout | null = null
    const killTree = (): void => {
      if (child.pid === undefined) return
      const pid = child.pid
      try {
        if (process.platform === 'win32') {
          if (child.exitCode === null && child.signalCode === null) {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'])
          }
        } else {
          process.kill(-pid, 'SIGTERM')
          killEscalation ??= setTimeout(() => {
            try { process.kill(-pid, 'SIGKILL') } catch { /* group already gone */ }
          }, 500)
          killEscalation.unref()
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

    const stdout: StreamBuffer = { head: '', tail: '', total: 0 }
    const stderr: StreamBuffer = { head: '', tail: '', total: 0 }
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    const pushText = (buf: StreamBuffer, text: string): void => {
      if (text === '') return
      buf.total += text.length
      if (buf.head.length < HEAD_CHARS) {
        const take = Math.min(text.length, HEAD_CHARS - buf.head.length)
        buf.head += text.slice(0, take)
        text = text.slice(take)
      }
      if (text !== '') {
        const cap = buf.total <= MAX_STREAM_CHARS ? MAX_STREAM_CHARS - HEAD_CHARS : TAIL_CHARS
        buf.tail = (buf.tail + text).slice(-cap)
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => pushText(stdout, outDecoder.write(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => pushText(stderr, errDecoder.write(chunk)))

    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let streamGrace: NodeJS.Timeout | null = null
    child.on('exit', (code, exitSignal) => {
      exitInfo = { code, signal: exitSignal }
      streamGrace = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
      }, 1_500)
    })

    const cleanup = (): void => {
      clearTimeout(timer)
      if (streamGrace !== null) clearTimeout(streamGrace)
      if (killEscalation !== null) clearTimeout(killEscalation)
      signal.removeEventListener('abort', onAbort)
    }

    child.on('error', (error) => {
      cleanup()
      reject(error)
    })
    child.on('close', (code, closeSignal) => {
      pushText(stdout, outDecoder.end())
      pushText(stderr, errDecoder.end())
      cleanup()
      resolve({
        stdout: formatBuffer(stdout),
        stderr: formatBuffer(stderr),
        code: exitInfo?.code ?? code,
        signal: exitInfo?.signal ?? closeSignal,
        timedOut
      })
    })
  })
}

/**
 * Killing only the shell leaves its children, dev servers, test runners,
 * running as orphans. The child gets its own process group (POSIX) so one
 * signal reaches everything it spawned; Windows walks the tree via taskkill.
 */
export function execute(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<CommandOutcome> {
  return runSpawn(
    () =>
      spawn(command, {
        shell: true,
        cwd,
        env: sanitizedEnv(),
        detached: process.platform !== 'win32'
      }),
    timeoutMs,
    signal
  )
}

/** Runs an executable directly without a shell, preventing argument metacharacter injection. */
export function executeFile(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<CommandOutcome> {
  return runSpawn(
    () =>
      spawn(file, args, {
        shell: false,
        cwd,
        env: sanitizedEnv(),
        detached: process.platform !== 'win32'
      }),
    timeoutMs,
    signal
  )
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
      : context.signal.aborted
        ? 'cancelled'
        : `exit code ${outcome.code ?? (outcome.signal ? `signal ${outcome.signal}` : 'unknown')}`

    const served = localServerUrl(`${outcome.stdout}\n${outcome.stderr}`)
    if (served !== null) {
      noteWebUrl(context.sessionId, served)
      if (context.sessionId) noteWebAutoOpen(context.sessionId)
    }

    const sections = [`$ ${input.command}`, `[${status}]`]
    if (outcome.stdout.trim() !== '') sections.push(`stdout:\n${outcome.stdout.trimEnd()}`)
    if (outcome.stderr.trim() !== '') sections.push(`stderr:\n${outcome.stderr.trimEnd()}`)
    if (outcome.stdout.trim() === '' && outcome.stderr.trim() === '') {
      sections.push('(no output)')
    }
    return { text: sections.join('\n'), images: [], isError: outcome.code !== 0 || outcome.timedOut || context.signal.aborted }
  }
})
