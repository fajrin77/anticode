import { closeBrowser } from '../browser'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { AgentEvent, SessionMode } from '@shared/ipc'
import { HISTORY_TOKEN_BUDGET } from '@shared/ipc'
import type { ContentBlock, LLMProvider, LLMResponse, Message } from '../providers/types'
import { toolDefinitions, tools } from '../tools'
import type { Tool } from '../tools'
import type { ApprovalGate } from '../approval/types'

const MAX_TOKENS = 32_000
const MAX_TOOL_OUTPUT = 10_000
/** Rough ceiling for replayed history; keeps long sessions off the context cliff. */
const MAX_HISTORY_TOKENS = HISTORY_TOKEN_BUDGET
const IMAGE_TOKEN_COST = 1600
/** Transient provider failures worth one automatic retry. */
const MAX_RETRIES = 2
/** Tool-result turns newer than this keep their verbatim output. */
const RECENT_TOOL_TURNS = 3
/** Older tool outputs are squashed to a short tail so the outcome still shows. */
const STUB_CHARS = 300
/** Stubbing only pays off once there is real bulk to remove. */
const STUB_MIN_LENGTH = STUB_CHARS + 400
/**
 * Ceilings for a single run, not for a session: they stop a loop that never
 * ends from burning the key, and resuming starts a fresh run on the same
 * history. A long refactor honestly spends hundreds of turns, so the turn
 * budget sits well above the point where real work stops and looping begins.
 */
const TURN_BUDGET = 500
const TOKEN_BUDGET = 2_000_000

interface RunParams {
  runId: string
  prompt: string
  signal: AbortSignal
  emit: (event: AgentEvent) => void
  /** Attachment blocks, already normalised, prepended to the user turn. */
  attachments?: ContentBlock[]
}

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use'
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(output: string): string {
  if (output === '') return '(no output)'
  return output.length > MAX_TOOL_OUTPUT
    ? `${output.slice(0, MAX_TOOL_OUTPUT)}\n… output truncated (${output.length} characters total)`
    : output
}

function stubOutput(content: string): string {
  return (
    `[earlier tool output elided — ${content.length} characters total]\n` +
    content.slice(-STUB_CHARS)
  )
}

/** Providers mark rate limits and outages with an HTTP-ish status property. */
function isTransient(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status !== 'number') return false
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('dibatalkan'))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Images cannot be sized by characters; a bounded screenshot costs this much. */
function blockCost(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return Math.ceil(block.text.length / 4)
    case 'image':
      return IMAGE_TOKEN_COST
    case 'tool_use':
      return Math.ceil(JSON.stringify(block.input ?? {}).length / 4) + 20
    case 'tool_result':
      return Math.ceil(block.content.length / 4) + 20
    case 'opaque':
      return 1_000
  }
}

export class AgentSession {
  private readonly history: Message[] = []
  private readonly transcript: Message[] = []
  private running = false
  private readonly byName = new Map<string, Tool>(tools.map((tool) => [tool.name, tool]))
  /** Images produced by tools this turn; appended after their tool results. */
  private pendingImages: ContentBlock[] = []
  private projectInstructions: string | null | undefined

  constructor(
    private readonly provider: LLMProvider,
    private readonly gate: ApprovalGate,
    private readonly mode: SessionMode = 'code',
    private readonly workspaceRoot: string | null = null,
    initialHistory: Message[] = [],
    private readonly scope: string = randomUUID()
  ) {
    this.history.push(...structuredClone(initialHistory))
    this.transcript.push(...this.history)
    this.sealPendingToolUses()
  }

  async run(params: RunParams): Promise<void> {
    if (this.running) throw new Error('A run is already active in this session')
    this.running = true
    try { await this.runExclusive(params) } finally { this.running = false }
  }

  private async runExclusive(params: RunParams): Promise<void> {
    const { runId, prompt, signal, emit } = params
    // A cancelled previous run may have left images behind; never leak them
    // into this turn's history.
    this.pendingImages = []
    this.record({
      role: 'user',
      content: [...(params.attachments ?? []), { type: 'text', text: prompt }]
    })

    let usedTokens = 0
    try {
      for (let step = 0; ; step++) {
        if (usedTokens >= TOKEN_BUDGET) throw new Error(`Run paused: this run spent its ${TOKEN_BUDGET / 1_000_000} million token budget. Press resume to carry on from here.`)
        if (step >= TURN_BUDGET) throw new Error(`Run paused: this run reached ${TURN_BUDGET} model turns, the guard against a loop that never ends. Press resume to carry on from here.`)
        if (signal.aborted) break

        this.condenseHistory()
        this.trimHistory()
        const response = await this.requestTurn(params)
        usedTokens += response.usage.inputTokens + response.usage.outputTokens
        this.record({ role: 'assistant', content: response.content })
        emit({
          type: 'usage',
          runId,
          provider: this.provider.name,
          model: this.provider.model,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens
        })

        if (signal.aborted) break
        if (response.stopReason !== 'tool_use') {
          emit({
            type: 'end',
            runId,
            reason: response.stopReason === 'end_turn' ? 'complete' : response.stopReason
          })
          return
        }

        // Stopping between the model asking for tools and the tools running must
        // not execute them; sealPendingToolUses then repairs the history.
        if (signal.aborted) break

        const calls = response.content.filter(isToolUse)
        const results = await this.executeCalls(calls, params)
        this.record({ role: 'user', content: [...results, ...this.pendingImages] })
        this.pendingImages = []
      }
    } catch (error) {
      this.pendingImages = []
      this.sealPendingToolUses()
      if (signal.aborted) {
        emit({ type: 'end', runId, reason: 'cancelled' })
      } else {
        emit({ type: 'error', runId, message: describeError(error) })
      }
      return
    }

    this.pendingImages = []
    this.sealPendingToolUses()
    emit({ type: 'end', runId, reason: 'cancelled' })
  }

  private async requestTurn(params: RunParams): Promise<LLMResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.streamTurn(params)
      } catch (error) {
        if (params.signal.aborted || attempt >= MAX_RETRIES || !isTransient(error)) throw error
        await delay(1_000 * 2 ** attempt, params.signal)
      }
    }
  }

  private async streamTurn(params: RunParams): Promise<LLMResponse> {
    let response: LLMResponse | null = null

    const iterator = this.provider.chat({
      system: this.systemPrompt(), messages: this.history,
      tools: this.mode === 'code' ? toolDefinitions() : [],
      maxTokens: MAX_TOKENS, signal: params.signal
    })[Symbol.asyncIterator]()
    let rejectAbort: (reason: unknown) => void = () => {}
    const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const onAbort = (): void => rejectAbort(new Error('Cancelled by the user'))
    params.signal.addEventListener('abort', onAbort, { once: true })
    try {
      params.signal.throwIfAborted()
      for (;;) {
        const next = await Promise.race([iterator.next(), cancelled])
        if (next.done) break
        params.signal.throwIfAborted()
        const event = next.value
        if (event.type === 'text_delta') params.emit({ type: 'text_delta', runId: params.runId, text: event.text })
        else response = event.response
      }
    } finally {
      params.signal.removeEventListener('abort', onAbort)
      // Some SDK iterators do not settle next() promptly on abort. Do not make
      // stopping the run depend on their iterator.return() finishing first.
      void iterator.return?.().catch(() => undefined)
    }

    if (!response) throw new Error('Provider returned no response')
    return response
  }

  /**
   * Squashes tool outputs from older turns to stubs — only the newest few tool
   * turns stay verbatim. Every request replays the whole history, so without
   * this each step gets slower as the session grows. Prompts, narration, and
   * errors (short by nature) are left untouched.
   */
  private condenseHistory(): void {
    let toolTurns = 0
    for (let i = this.history.length - 1; i >= 0; i--) {
      const message = this.history[i]
      if (message === undefined || message.role !== 'user') continue
      if (!message.content.some((block) => block.type === 'tool_result')) continue
      toolTurns += 1
      if (toolTurns <= RECENT_TOOL_TURNS) continue
      this.history[i] = {
        role: 'user',
        content: message.content.map((block) => {
          if (block.type === 'tool_result' && block.content.length > STUB_MIN_LENGTH) {
            return { ...block, content: stubOutput(block.content) }
          }
          // Old screenshots cost image pricing every turn; their moment passed.
          if (block.type === 'image') {
            return { type: 'text', text: '[screenshot from an earlier step elided]' }
          }
          return block
        })
      }
    }
  }

  /**
   * Drops the oldest prompt turns once the replayed history would blow past the
   * context budget. Cuts only at plain user prompts — never between an
   * assistant tool_use and its tool_result, which providers reject.
   */
  private trimHistory(): void {
    const total = this.history.reduce((sum, message) => sum + messageCost(message), 0)
    if (total <= MAX_HISTORY_TOKENS) return

    const suffixCosts: number[] = new Array(this.history.length)
    let running = 0
    for (let i = this.history.length - 1; i >= 0; i--) {
      running += messageCost(this.history[i] ?? { role: 'user', content: [] })
      suffixCosts[i] = running
    }

    let cut = -1
    for (let i = 0; i < this.history.length; i++) {
      const message = this.history[i]
      if (message === undefined) continue
      const isPlainUserPrompt =
        message.role === 'user' && !message.content.some((block) => block.type === 'tool_result')
      if (!isPlainUserPrompt) continue
      const suffix = suffixCosts[i]
      if (suffix !== undefined && suffix <= MAX_HISTORY_TOKENS) { cut = i; break }
    }

    // Do not repeatedly send an oversized single turn to the provider. A new
    // user prompt supplies a safe boundary for the next continuation.
    if (cut < 0) throw new Error('This turn exceeds the context budget. Send a shorter continuation or start a new session.')
    if (cut === 0) return
    this.history.splice(0, cut)
  }

  private async executeCalls(calls: ToolUseBlock[], params: RunParams): Promise<ContentBlock[]> {
    const results = new Array<ContentBlock | undefined>(calls.length)
    const entries = calls.map((call, index) => ({ call, index }))
    const isReadOnly = (name: string): boolean => this.byName.get(name)?.readOnly === true

    await Promise.all(
      entries
        .filter((entry) => isReadOnly(entry.call.name))
        .map(async (entry) => {
          results[entry.index] = await this.executeCall(entry.call, params)
        })
    )

    for (const entry of entries.filter((entry) => !isReadOnly(entry.call.name))) {
      results[entry.index] = await this.executeCall(entry.call, params)
    }

    return results.filter((block): block is ContentBlock => block !== undefined)
  }

  private async executeCall(call: ToolUseBlock, params: RunParams): Promise<ContentBlock> {
    const { runId, emit } = params
    emit({ type: 'tool_start', runId, toolUseId: call.id, name: call.name, input: call.input })

    if (params.signal.aborted) return this.finishCall(params, call.id, 'Cancelled by the user.', true)
    const tool = this.byName.get(call.name)
    if (!tool) {
      return this.finishCall(params, call.id, `Unknown tool: ${call.name}`, true)
    }

    if (this.workspaceRoot === null) {
      return this.finishCall(params, call.id, 'This session has no file access.', true)
    }
    const context = { workspaceRoot: this.workspaceRoot, signal: params.signal, sessionId: this.scope }

    try {
      const prepared = tool.prepare(call.input)

      const approved = await this.gate.authorize({
        runId,
        sessionId: this.scope,
        toolName: tool.name,
        risk: prepared.risk,
        preview: () => prepared.preview(context),
        signal: params.signal
      })
      if (!approved) {
        return this.finishCall(params, call.id, 'Rejected by the user.', true, true)
      }

      params.signal.throwIfAborted()
      const output = await prepared.execute(context)
      this.pendingImages.push(
        ...output.images.map((image) => ({
          type: 'image' as const,
          mediaType: image.mediaType,
          data: image.data
        }))
      )
      return this.finishCall(params, call.id, truncate(output.text), output.isError === true)
    } catch (error) {
      return this.finishCall(params, call.id, describeError(error), true)
    }
  }

  private finishCall(
    params: RunParams,
    toolUseId: string,
    output: string,
    isError: boolean,
    rejected = false
  ): ContentBlock {
    params.emit({
      type: 'tool_end',
      runId: params.runId,
      toolUseId,
      ok: !isError,
      output,
      ...(rejected ? { rejected: true } : {})
    })
    return { type: 'tool_result', toolUseId, content: output, isError }
  }

  /**
   * A cancelled turn can leave an assistant message whose tool_use blocks have no
   * matching tool_result. Providers reject that history on the next request, so
   * close the gap before the run ends.
   */
  private sealPendingToolUses(): void {
    const last = this.history.at(-1)
    if (!last || last.role !== 'assistant') return

    const pending = last.content.filter(isToolUse)
    if (pending.length === 0) return

    this.record({
      role: 'user',
      content: pending.map((block) => ({
        type: 'tool_result' as const,
        toolUseId: block.id,
        content: 'Cancelled by the user before the tool ran.',
        isError: true
      }))
    })
  }

  /** Read the project's own instructions once per session, refreshed lazily. */
  private loadProjectInstructions(): string | null {
    if (this.projectInstructions !== undefined || this.workspaceRoot === null) {
      return this.projectInstructions ?? null
    }
    this.projectInstructions = null
    for (const name of ['AGENTS.md', 'CLAUDE.md', '.anticode.md']) {
      try {
        const raw = readWorkspaceFile(this.workspaceRoot, name)
        if (raw === null) continue
        const trimmed = raw.trim()
        if (trimmed === '') continue
        this.projectInstructions =
          trimmed.length > 4_000 ? `${trimmed.slice(0, 4_000)}\n… (truncated)` : trimmed
        break
      } catch {
        // Unreadable instructions must never break the session.
      }
    }
    return this.projectInstructions
  }

  get title(): string {
    return this.transcript.find((message) => message.role === 'user')?.content.find((block) => block.type === 'text')?.text.slice(0, 60) ?? 'New session'
  }

  get messageCount(): number { return this.transcript.length }

  private record(message: Message): void { this.history.push(message); this.transcript.push(message) }

  dispose(): void { void closeBrowser(this.scope) }

  /** A copy of the replayed history, for the remote API and dashboards. */
  snapshot(): { messages: Message[] } {
    return { messages: structuredClone(this.transcript) }
  }

  private systemPrompt(): string {
    if (this.mode === 'chat') {
      return [
        'You are antichat, the ask-and-answer mode of anticode.',
        'You have no access to files, terminals, or the network.',
        'If the user asks for something that needs reading or changing files, say that it ' +
          'requires an anticode session connected to a project folder.',
        'Reply in the language the user writes in; be concise and to the point.',
        'Do not use emojis or decorative symbols in your replies.'
      ].join('\n')
    }

    const lines = [
      'You are anticode, a coding agent working inside a single project folder owned by the user.',
      `Workspace root: ${this.workspaceRoot}`,
      `Operating system: ${process.platform}`,
      '',
      'Working rules:',
      '- Every path you pass to a tool is relative to the workspace root.',
      '- Use search_files to locate code instead of reading files one by one.',
      '- Read a file before changing it; never guess its contents.',
      '- For partial changes use edit_file, not write_file.',
      '- Work in as few steps as possible: issue independent tool calls together in one turn ' +
        'and combine related shell commands into one.',
      '- Check that a tool or dependency already exists before installing or re-running it.',
      '- Stop as soon as the task succeeds; do not re-run commands to double-check.',
      '- If a tool fails, read its error message and adjust your approach.',
      '- Reply in the language the user writes in; be concise and to the point.',
      '- Do not use emojis or decorative symbols in your replies.'
    ]

    const instructions = this.loadProjectInstructions()
    if (instructions !== null) {
      lines.push('', `Additional rules from the project:\n\n${instructions}`)
    }
    return lines.join('\n')
  }
}

function messageCost(message: Message): number {
  return message.content.reduce((sum, block) => sum + blockCost(block), 0)
}

function readWorkspaceFile(root: string, name: string): string | null {
  try {
    return readFileSync(`${root}/${name}`, 'utf8')
  } catch {
    return null
  }
}
