import { closeBrowser } from '../browser'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AgentEvent, SessionMode } from '@shared/ipc'
import { HISTORY_TOKEN_BUDGET } from '@shared/ipc'
import type { ContentBlock, LLMProvider, LLMResponse, Message } from '../providers/types'
import { toolDefinitions, toolsFor } from '../tools'
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
/** Leave room for the system prompt, tool schemas, and the next response. */
const COMPACTION_TARGET = Math.floor(MAX_HISTORY_TOKENS * 0.72)
const MEMORY_MAX_CHARS = 12_000
/*
 * A run has no turn or token ceiling. Long work has to be allowed to finish,
 * and a cap that stops it mid-task costs more than it saves — the work is
 * half-done and the next run replays the whole history to catch up. Pause is
 * the stop button, and it reaches this run from either device.
 */

interface RunParams {
  runId: string
  prompt: string
  signal: AbortSignal
  emit: (event: AgentEvent) => void
  /** Attachment blocks, already normalised, prepended to the user turn. */
  attachments?: ContentBlock[]
}

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

/**
 * Asked when a request fails: the provider to try the same turn with instead,
 * or null when there is none left and the failure should stand.
 */
export type ProviderFallback = (error: unknown) => LLMProvider | null

/**
 * How a follow-up reads to the model: an addition to the task in hand, not a
 * replacement for it. Without the framing a model tends to drop what it was
 * doing and answer only the newest message.
 */
function framedFollowUp(text: string): string {
  return (
    '[Pesan tambahan dari pengguna, dikirim saat kamu masih mengerjakan tugas sebelumnya. ' +
    'Tugas sebelumnya belum selesai: lanjutkan, dan kerjakan juga ini.]\n\n' +
    text
  )
}

interface FollowUp {
  text: string
  attachments: ContentBlock[]
}

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

/** Provider SDKs expose Retry-After either as seconds or an HTTP date. */
function retryDelay(error: unknown, attempt: number): number {
  const record = error as { headers?: Record<string, unknown>; retryAfter?: unknown } | null
  const raw = record?.retryAfter ?? record?.headers?.['retry-after'] ?? record?.headers?.['Retry-After']
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.min(30_000, Math.max(0, raw * 1_000))
  if (typeof raw === 'string') {
    const seconds = Number(raw)
    if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1_000))
    const at = Date.parse(raw)
    if (Number.isFinite(at)) return Math.min(30_000, Math.max(0, at - Date.now()))
  }
  // Small jitter prevents several simultaneous sessions retrying in lockstep.
  return 1_000 * 2 ** attempt + Math.floor(Math.random() * 250)
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
  /** Only the tools this mode offers: a name the model invents runs nothing. */
  private readonly byName: Map<string, Tool>
  /** Images produced by tools this turn; appended after their tool results. */
  private pendingImages: ContentBlock[] = []
  private projectInstructions: string | null | undefined
  /** Instructions sent while a run was working, waiting for its next step. */
  private followUps: FollowUp[] = []
  private activeSignal: AbortSignal | null = null
  /** Rotation only: who takes a turn the current provider could not serve. */
  private fallback: ProviderFallback | null = null
  /** One pre-edit snapshot map per user run, newest last. */
  private readonly checkpoints: Map<string, Buffer | null>[] = []
  private currentCheckpoint: Map<string, Buffer | null> | null = null

  constructor(
    private provider: LLMProvider,
    private readonly gate: ApprovalGate,
    private readonly mode: SessionMode = 'code',
    private readonly workspaceRoot: string | null = null,
    initialHistory: Message[] = [],
    private readonly scope: string = randomUUID()
  ) {
    this.byName = new Map(toolsFor(mode).map((tool) => [tool.name, tool]))
    this.history.push(...structuredClone(initialHistory))
    this.transcript.push(...this.history)
    this.sealPendingToolUses()
  }

  /**
   * The model the next run talks to. Only between runs: a run keeps the
   * provider it started with, apart from the hand-overs its fallback makes.
   */
  useProvider(provider: LLMProvider, fallback: ProviderFallback | null = null): void {
    if (this.running) throw new Error('A run is already active in this session')
    this.provider = provider
    this.fallback = fallback
  }

  get providerName(): string { return this.provider.name }
  get model(): string { return this.provider.model }

  async run(params: RunParams): Promise<void> {
    if (this.running) throw new Error('A run is already active in this session')
    this.running = true
    this.activeSignal = params.signal
    try {
      await this.runExclusive(params)
    } finally {
      this.running = false
      this.activeSignal = null
      // A pause can land between an instruction arriving and the run taking it
      // in. It was sent, and the user saw it sent, so it goes into the history
      // rather than vanishing — the next run (a resume) reads it there.
      this.settleFollowUps()
    }
  }

  /**
   * Hands an instruction to the run that is working now. It is taken in at
   * the run's next step — after the tools in flight return, or once the model
   * finishes the reply it is writing — and the run carries on with both. False
   * when there is no run to hand it to, or the one there is already stopping.
   */
  steer(text: string, attachments: ContentBlock[] = []): boolean {
    if (!this.running || this.activeSignal === null || this.activeSignal.aborted) return false
    this.followUps.push({ text, attachments })
    return true
  }

  private takeFollowUps(during: boolean): ContentBlock[] {
    const taken = this.followUps
    this.followUps = []
    return taken.flatMap((entry) => [
      ...entry.attachments,
      { type: 'text' as const, text: framedFollowUp(entry.text), followUp: { text: entry.text, during } }
    ])
  }

  private settleFollowUps(): void {
    if (this.followUps.length === 0) return
    const blocks = this.takeFollowUps(false)
    // Folded into the last user turn so the history keeps alternating; a fresh
    // user turn only when the history ends on the model. Condensing gives the
    // replayed history its own copies, so the transcript is written separately.
    const replayed = this.history.at(-1)
    const kept = this.transcript.at(-1)
    if (replayed?.role === 'user' && kept?.role === 'user') {
      replayed.content.push(...blocks)
      if (kept.content !== replayed.content) kept.content.push(...blocks)
    } else {
      this.record({ role: 'user', content: blocks })
    }
  }

  private async runExclusive(params: RunParams): Promise<void> {
    const { runId, prompt, signal, emit } = params
    // Taking instructions in is what moves every viewer's reply below them.
    const takeIn = (): ContentBlock[] => {
      const blocks = this.takeFollowUps(true)
      if (blocks.length > 0) emit({ type: 'steer_taken', runId })
      return blocks
    }
    // A cancelled previous run may have left images behind; never leak them
    // into this turn's history.
    this.pendingImages = []
    this.currentCheckpoint = new Map()
    this.checkpoints.push(this.currentCheckpoint)
    this.record({
      role: 'user',
      content: [...(params.attachments ?? []), { type: 'text', text: prompt }]
    })

    try {
      for (;;) {
        if (signal.aborted) break

        this.condenseHistory()
        this.trimHistory()
        const response = await this.requestTurn(params)
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
          // An instruction that arrived while the model was writing its last
          // reply keeps the run going: it is the next thing to do.
          if (response.stopReason === 'end_turn' && this.followUps.length > 0) {
            this.record({ role: 'user', content: takeIn() })
            continue
          }
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
        // Follow-ups ride in the same user turn as the tool results, after
        // them: the model reads what its tools did, then what was added.
        const added = signal.aborted ? [] : takeIn()
        this.record({ role: 'user', content: [...results, ...this.pendingImages, ...added] })
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
        if (params.signal.aborted) throw error
        // Under rotation a provider that fails — rate limited, out of quota,
        // down — hands the turn to the next one at once rather than being
        // waited out. Only once every one has failed do the retries below run.
        const next = this.fallback?.(error) ?? null
        if (next !== null) {
          this.provider = next
          attempt = -1
          continue
        }
        if (attempt >= MAX_RETRIES || !isTransient(error)) throw error
        await delay(retryDelay(error, attempt), params.signal)
      }
    }
  }

  private async streamTurn(params: RunParams): Promise<LLMResponse> {
    let response: LLMResponse | null = null

    const iterator = this.provider.chat({
      system: this.systemPrompt(), messages: this.history,
      tools: toolDefinitions(this.mode),
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
    const removed = this.history.splice(0, cut)
    const memory = summariseMessages(removed)
    if (memory !== '') {
      this.history.unshift({
        role: 'user',
        content: [{
          type: 'text',
          text: '[Automatic context compaction — durable memory from earlier turns]\n' + memory
        }]
      })
      // A verbose summary must never put replay back over the cliff.
      while (this.history.length > 1 && replayCost(this.history) > COMPACTION_TARGET) {
        const boundary = this.history.findIndex((message, index) =>
          index > 1 && message.role === 'user' && !message.content.some((block) => block.type === 'tool_result'))
        if (boundary < 0) break
        this.history.splice(1, boundary - 1)
      }
    }
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

      // antichat asks nothing: its tools only reach copies in its own private
      // folder, with no terminal, deleting, or network to be careful about.
      const approved =
        this.mode === 'chat' ||
        (await this.gate.authorize({
          runId,
          sessionId: this.scope,
          toolName: tool.name,
          risk: prepared.risk,
          preview: () => prepared.preview(context),
          signal: params.signal
        }))
      if (!approved) {
        return this.finishCall(params, call.id, 'Rejected by the user.', true, true)
      }

      params.signal.throwIfAborted()
      this.captureCheckpoint(call)
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
    return titleOf(this.transcript)
  }

  get messageCount(): number { return this.transcript.length }

  /**
   * Drops the most recent exchange — the last typed prompt and everything the
   * run made of it — and hands the prompt back so it can be corrected and sent
   * again. Only meaningful between runs; the caller cancels first.
   *
   * `history` is the replayed context and `transcript` is the record: they are
   * condensed and trimmed differently, but only ever from the front, so their
   * tails stay in step and the same count comes off both.
   */
  revertLastTurn(): string | null {
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const message = this.transcript[i]
      if (message?.role !== 'user') continue
      // Tool results are also user turns; the prompt is the one with prose.
      const text = message.content.find(
        (block): block is Extract<ContentBlock, { type: 'text' }> =>
          block.type === 'text' && block.attachment === undefined
      )
      if (text === undefined) continue
      this.transcript.length = i
      // Replay may contain a synthetic compaction summary, so its length no
      // longer mirrors the full transcript. Cut at its own latest plain user
      // prompt instead of subtracting transcript message counts.
      for (let replay = this.history.length - 1; replay >= 0; replay--) {
        const candidate = this.history[replay]
        if (candidate?.role !== 'user' || candidate.content.some((block) => block.type === 'tool_result')) continue
        if (!candidate.content.some((block) => block.type === 'text' && block.attachment === undefined)) continue
        this.history.length = replay
        break
      }
      this.restoreLastCheckpoint()
      return text.text
    }
    return null
  }

  private record(message: Message): void { this.history.push(message); this.transcript.push(message) }

  /** Capture original bytes once, immediately before a file mutation. */
  private captureCheckpoint(call: ToolUseBlock): void {
    if (this.currentCheckpoint === null || this.workspaceRoot === null) return
    if (!['edit_file', 'write_file', 'delete_file'].includes(call.name)) return
    const input = call.input as { path?: unknown } | null
    if (typeof input?.path !== 'string') return
    const target = path.resolve(this.workspaceRoot, input.path)
    const relative = path.relative(this.workspaceRoot, target)
    if (relative.startsWith('..') || path.isAbsolute(relative) || this.currentCheckpoint.has(target)) return
    try {
      this.currentCheckpoint.set(target, existsSync(target) ? readFileSync(target) : null)
    } catch {
      // Directories and unreadable files are not copied as unbounded archives.
    }
  }

  private restoreLastCheckpoint(): void {
    const checkpoint = this.checkpoints.pop()
    this.currentCheckpoint = this.checkpoints.at(-1) ?? null
    if (checkpoint === undefined) return
    for (const [target, original] of [...checkpoint].reverse()) {
      try {
        if (original === null) rmSync(target, { force: true })
        else {
          mkdirSync(path.dirname(target), { recursive: true })
          writeFileSync(target, original)
        }
      } catch {
        // Transcript revert remains usable if an external process locked a file.
      }
    }
  }

  dispose(): void { void closeBrowser(this.scope) }

  /** A copy of the replayed history, for the remote API and dashboards. */
  snapshot(): { messages: Message[] } {
    return { messages: structuredClone(this.transcript) }
  }

  get contextTokens(): number { return replayCost(this.history) }

  private systemPrompt(): string {
    if (this.mode === 'chat') {
      return [
        'You are antichat, the ask-and-answer mode of anticode.',
        'You have no terminal, no network, and no project folder.',
        'Files the user attaches are copied into a private folder that belongs to this ' +
          'conversation; each attachment header names its path there. Your document tools ' +
          '(read and write files, Excel, Word, PDF) take paths relative to that folder, and ' +
          'nothing outside it is reachable.',
        'To change an attached file, read it first, then edit that copy in place — or write a ' +
          'new file next to it when the user wants a separate one. You can also create new ' +
          'documents there. Every document you write is offered to the user as a download on ' +
          'the desktop and the phone, so say what you changed instead of pasting the file back.',
        'Without an attachment there is nothing to edit: ask the user to attach the file.',
        'Do not offer scripts for the user to run as a substitute unless they ask for one.',
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
      '- For work with three or more meaningful steps, use todo_write before editing and keep it current.',
      '- Check that a tool or dependency already exists before installing or re-running it.',
      '- Stop as soon as the task succeeds; do not re-run commands to double-check.',
      '- If a tool fails, read its error message and adjust your approach.',
      '- Files the user attaches from outside the project are copied into .anticode/uploads/. ' +
        'To change one, work on that copy; the files you write are offered to the user as downloads.',
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

/**
 * What the user typed first. Attachment headers ride ahead of the prompt in
 * the same turn, so the first text block is not enough — it would name the
 * session after a file.
 */
export function titleOf(messages: Message[]): string {
  const first = messages.find((message) => message.role === 'user')
  const typed = first?.content.find((block) => block.type === 'text' && block.attachment === undefined)
  return typed?.type === 'text' ? typed.text.slice(0, 60) : 'New session'
}

function messageCost(message: Message): number {
  return message.content.reduce((sum, block) => sum + blockCost(block), 0)
}

function replayCost(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + messageCost(message), 0)
}

/** Keep intent, conclusions, calls, and outcomes without depending on a live provider. */
function summariseMessages(messages: Message[]): string {
  const lines: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      let line = ''
      if (block.type === 'text') {
        line = `${message.role === 'user' ? 'User' : 'Assistant'}: ${block.followUp?.text ?? block.text}`
      } else if (block.type === 'tool_use') {
        const input = block.input as Record<string, unknown> | null
        const subject = typeof input?.path === 'string'
          ? ` ${input.path}`
          : typeof input?.command === 'string'
            ? ` ${input.command.slice(0, 180)}`
            : ''
        line = `Tool requested: ${block.name}${subject}`
      } else if (block.type === 'tool_result') {
        line = `Tool outcome: ${block.content.slice(-500)}`
      }
      const compact = line.replace(/\s+/g, ' ').trim()
      if (compact !== '') lines.push(`- ${compact.slice(0, 800)}`)
    }
  }
  let result = lines.join('\n')
  if (result.length > MEMORY_MAX_CHARS) {
    result = `- Earlier details omitted during compaction.\n${result.slice(-MEMORY_MAX_CHARS)}`
  }
  return result
}

function readWorkspaceFile(root: string, name: string): string | null {
  try {
    return readFileSync(`${root}/${name}`, 'utf8')
  } catch {
    return null
  }
}
