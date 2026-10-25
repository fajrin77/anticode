import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatParams, LLMProvider, LLMResponse, ProviderEvent } from './types'
import { ProviderRequestError } from './requestError'

export interface CursorCommand { executable: string; prefix: string[] }
/** Resolve an existing installation. Never download or install on the user's behalf. */
export async function cursorCommand(): Promise<CursorCommand> {
  const configured = process.env.ANTICODE_CURSOR_CLI
  if (configured) {
    if (!path.isAbsolute(configured) || !existsSync(configured)) throw new Error('ANTICODE_CURSOR_CLI must point to an installed executable')
    return { executable: configured, prefix: [] }
  }
  const root = path.join(homedir(), '.local', 'share', 'cursor-agent', 'versions')
  try {
    for (const version of (await readdir(root)).sort().reverse()) {
      const dir = path.join(root, version)
      const node = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node')
      const script = path.join(dir, 'index.js')
      if (existsSync(node) && existsSync(script)) return { executable: node, prefix: [script] }
    }
  } catch { /* Look in PATH next. */ }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const executable = path.join(dir, process.platform === 'win32' ? 'cursor-agent.exe' : 'cursor-agent')
    if (existsSync(executable)) return { executable, prefix: [] }
  }
  throw new Error('Install the official Cursor Agent CLI first, or set ANTICODE_CURSOR_CLI to its executable. No CLI is bundled with Anticode.')
}

export async function runCursor(args: string[], token: string, signal?: AbortSignal, stdin?: string): Promise<string> {
  const command = await cursorCommand()
  const dir = await mkdtemp(path.join(tmpdir(), 'anticode-cursor-'))
  try {
    const config = path.join(dir, 'config')
    await mkdir(config)
    await writeFile(path.join(config, 'cli-config.json'), JSON.stringify({ version: 1, permissions: { allow: [], deny: ['Shell(*)', 'Read(*)', 'Write(*)', 'Grep(*)', 'WebFetch(*)', 'WebSearch(*)', 'Task(*)', 'Mcp(*)'] }, approvalMode: 'allowlist' }), { mode: 0o600 })
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(command.executable, [...command.prefix, ...args], {
        cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: { PATH: process.env.PATH ?? '', HOME: dir, USERPROFILE: dir, APPDATA: config, LOCALAPPDATA: config, XDG_CONFIG_HOME: config, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), CURSOR_AUTH_TOKEN: token, CURSOR_CONFIG_DIR: config, AGENT_CLI_CREDENTIAL_STORE: 'memory', DIRENV_DISABLE: '1', NO_COLOR: '1' }
      })
      let output = ''
      let settled = false
      const timer = setTimeout(() => { child.kill(); finish(new Error('Cursor CLI timed out')) }, 180_000)
      const abort = (): void => { child.kill(); finish(new Error('Cursor request cancelled')) }
      function finish(error?: Error): void {
        if (settled) return
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
        if (error) reject(error); else resolve(output)
      }
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        if (output.length > 16_000_000) { child.kill(); finish(new Error('Cursor output exceeds limit')) }
      })
      // stderr can include sensitive provider diagnostics; do not log or expose it.
      child.stderr.resume()
      child.on('error', () => finish(new Error('Could not start Cursor CLI')))
      child.on('close', (code) => finish(code === 0 ? undefined : new Error(`Cursor CLI failed (${code ?? 'terminated'}). Check login, CLI version and model access.`)))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      child.stdin.on('error', () => {})
      child.stdin.end(stdin)
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
}

export function parseCursorModels(output: string): string[] {
  // Official `--list-models` output is one slug followed by " - <label>".
  return [...new Set(output.split('\n').map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim()).flatMap((line) => {
    const match = /^([a-z0-9][a-z0-9._:/-]*)\s+-\s+\S/i.exec(line)
    return match?.[1] && match[1] !== 'auto' ? [match[1]] : []
  }))]
}
export async function cursorModels(token: string): Promise<string[]> {
  const models = parseCursorModels(await runCursor(['--list-models'], token))
  if (!models.length) throw new Error('Cursor CLI returned no recognized models. Update the CLI or check account access.')
  return models
}

export function parseCursorReply(text: string, params: ChatParams): LLMResponse {
  let parsed: { text?: unknown; tool_calls?: { name: string; arguments: unknown }[] }
  try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()) as typeof parsed } catch {
    return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }
  }
  const content: LLMResponse['content'] = []
  if (typeof parsed.text === 'string' && parsed.text) content.push({ type: 'text', text: parsed.text })
  for (const call of parsed.tool_calls ?? []) {
    if (!params.tools.some((t) => t.name === call.name) || typeof call.arguments !== 'object' || !call.arguments || Array.isArray(call.arguments)) throw new ProviderRequestError('Cursor requested an unknown or invalid Anticode tool', 400)
    content.push({ type: 'tool_use', id: randomUUID(), name: call.name, input: call.arguments as Record<string, unknown> })
  }
  return { content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }
}

export class CursorCliProvider implements LLMProvider {
  readonly name = 'cursor'
  readonly id = 'cursor'
  constructor(private token: string, readonly model: string) {}
  private async response(params: ChatParams): Promise<LLMResponse> {
    if (params.messages.some((m) => m.content.some((b) => b.type === 'image'))) throw new ProviderRequestError('Cursor CLI adapter currently supports text and tool messages only', 400)
    const prompt = `${params.system}\n\nYou are an inference adapter inside Anticode. Do not use native Cursor tools. Return ONLY JSON: {"text":"answer", "tool_calls":[{"name":"exact tool name","arguments":{}}]}. To use a tool, return tool_calls and stop. Anticode executes them with its permission checks and returns results next turn. Available tools:\n${JSON.stringify(params.tools)}\nConversation:\n${JSON.stringify(params.messages)}`
    const raw = await runCursor(['--print', '--mode', 'ask', '--output-format', 'json', '--model', this.model, '--disable-indexing', '--disable-codebase-ref'], this.token, params.signal, prompt)
    let envelope: { result?: string; is_error?: boolean; model?: string; usage?: { input_tokens?: number; output_tokens?: number } }
    try { envelope = JSON.parse(raw) as typeof envelope } catch { throw new Error('Cursor CLI returned invalid JSON output') }
    if (envelope.is_error || typeof envelope.result !== 'string') throw new Error('Cursor CLI did not return a successful result')
    if (envelope.model && envelope.model !== this.model) throw new ProviderRequestError('Cursor returned a different model than requested', 400)
    const result = parseCursorReply(envelope.result, params)
    result.usage = { inputTokens: envelope.usage?.input_tokens ?? 0, outputTokens: envelope.usage?.output_tokens ?? 0 }
    return result
  }
  async *chat(params: ChatParams): AsyncGenerator<ProviderEvent> {
    const result = await this.response(params)
    for (const block of result.content) {
      if (block.type === 'text') yield { type: 'text_delta', text: block.text }
    }
    yield { type: 'response', response: result }
  }
}
