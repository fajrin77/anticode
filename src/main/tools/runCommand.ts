import { spawn } from 'node:child_process'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'
import { isDestructiveCommand } from '../approval/policy'

const MAX_STREAM_CHARS = 20_000

interface CommandOutcome {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
}

function collect(chunks: string[], limit: number): string {
  const joined = chunks.join('')
  return joined.length > limit
    ? `${joined.slice(0, limit)}\n… keluaran dipotong (${joined.length} karakter total)`
    : joined
}

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
      signal,
      timeout: timeoutMs,
      killSignal: 'SIGKILL'
    })

    const stdout: string[] = []
    const stderr: string[] = []
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')))

    child.on('error', reject)
    child.on('close', (code, closeSignal) => {
      resolve({
        stdout: collect(stdout, MAX_STREAM_CHARS),
        stderr: collect(stderr, MAX_STREAM_CHARS),
        code,
        signal: closeSignal
      })
    })
  })
}

export const runCommandTool = defineTool({
  name: 'run_command',
  description:
    'Jalankan perintah shell di dalam workspace dan kembalikan stdout, stderr, serta exit code. ' +
    'Working directory selalu dibatasi ke dalam workspace dan setiap perintah punya batas waktu.',
  readOnly: false,
  risk: (input) => (isDestructiveCommand(input.command) ? 'high' : 'medium'),
  preview: async (input) => ({
    kind: 'command',
    subject: input.cwd === '.' ? 'workspace root' : input.cwd,
    detail: `$ ${input.command}\n\ncwd: ${input.cwd}\ntimeout: ${input.timeout_ms} ms`
  }),
  schema: z.object({
    command: z.string().min(1).describe('Perintah shell yang dijalankan'),
    cwd: z
      .string()
      .default('.')
      .describe('Working directory relatif terhadap root workspace'),
    timeout_ms: z
      .number()
      .int()
      .min(1000)
      .max(600_000)
      .default(120_000)
      .describe('Batas waktu eksekusi dalam milidetik')
  }),
  execute: async (input, context) => {
    const cwd = resolveInWorkspace(context.workspaceRoot, input.cwd)

    let outcome: CommandOutcome
    try {
      outcome = await execute(input.command, cwd, input.timeout_ms, context.signal)
    } catch (error) {
      if (context.signal.aborted) throw new ToolError('Perintah dibatalkan oleh pengguna')
      throw new ToolError(`Gagal menjalankan perintah: ${(error as Error).message}`)
    }

    const status =
      outcome.signal === 'SIGKILL'
        ? `dihentikan setelah ${input.timeout_ms} ms`
        : `exit code ${outcome.code ?? 'tidak diketahui'}`

    const sections = [`$ ${input.command}`, `[${status}]`]
    if (outcome.stdout.trim() !== '') sections.push(`stdout:\n${outcome.stdout.trimEnd()}`)
    if (outcome.stderr.trim() !== '') sections.push(`stderr:\n${outcome.stderr.trimEnd()}`)
    if (outcome.stdout.trim() === '' && outcome.stderr.trim() === '') {
      sections.push('(tanpa keluaran)')
    }
    return sections.join('\n')
  }
})
