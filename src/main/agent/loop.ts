import { closeBrowser } from '../browser'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CheckpointStore } from '../checkpoints'
import type { WorkspaceScan } from '../checkpoints'
import type { AgentEvent, SessionMode } from '@shared/ipc'
import { HISTORY_TOKEN_BUDGET } from '@shared/ipc'
import { isTypedPrompt, MEMORY_HEADER } from './turns'
import type { ContentBlock, LLMProvider, LLMResponse, Message, ProviderEvent, Usage } from '../providers/types'
import { definitionsOf, subagentTools, toolsFor, ToolError } from '../tools'
import type { Tool } from '../tools'
import type { DelegatedTask } from '../tools/types'
import type { ApprovalGate } from '../approval/types'
import { isOutOfUsage } from '../usageErrors'

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
const DEFAULT_COMPACTION_TARGET = Math.floor(MAX_HISTORY_TOKENS * 0.72)
const MEMORY_MAX_CHARS = 12_000
/** How much of the dropped turns the model is shown when it writes the memory. */
const COMPACTION_INPUT_CHARS = 160_000
const COMPACTION_MAX_TOKENS = 4_096
/** A summary that takes longer than this falls back to the deterministic one. */
const COMPACTION_TIMEOUT_MS = 120_000
const COMPACTION_SYSTEM = [
  'You compact the earlier part of a working session between a user and anticode, a coding agent, so the ' +
    'agent can carry on without the full history.',
  'Write the memory in one language only — the language the user mostly writes in. Never mix languages in ' +
    'one sentence, never insert words from another language for terms that have an everyday word in the ' +
    "user's language. Keep code identifiers, file paths, commands, and model names exactly as they appear.",
  'Structure it under short headings:',
  '- Goal and requirements: what the user wants, constraints, preferences, and corrections they gave.',
  '- Decisions: what was chosen and why.',
  '- Files: paths created, changed, or inspected, with the specifics that matter (functions, settings, lines).',
  '- Commands and results: what ran, errors, test outcomes.',
  '- State: what is done, what is in progress, and the next steps.',
  'If the conversation opens with an earlier memory, fold it in rather than repeating it.',
  'State only what the conversation shows. No preamble or pleasantries; at most about 1200 words.'
].join('\n')
/**
 * A sub-agent answers one question, so unlike a run it has a ceiling: past
 * this many requests it is told to report, and a little later it is stopped.
 */
const SUBAGENT_MAX_STEPS = 30
const SUBAGENT_GRACE_STEPS = 2
/** Main runs get a generous ceiling, but may never spend without bound. */
const AGENT_MAX_STEPS = 50
const AGENT_GRACE_STEPS = 2
/** Three identical tool rounds in a row are almost certainly a stuck model. */
const MAX_IDENTICAL_TOOL_ROUNDS = 3

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

/** A prompt taken back out of the session, ready to be edited or sent again. */
export interface TakenBack {
  prompt: string
  /** Everything else in that turn — attachment headers, images, folded follow-ups. */
  attachments: ContentBlock[]
  /** The part of the record that went, for callers that keep per-turn tallies. */
  removed: Message[]
}

export interface AgentOptions {
  /** Replaces the mode's tool set — a sub-agent gets the read-only kit. */
  tools?: Tool[]
  /** Answers one question for a parent run, then stops; it has a step ceiling. */
  subagent?: boolean
  /** Where this session's file checkpoints live, so Revert survives a restart. */
  checkpointDir?: string
  /**
   * The user's own instructions — for every session, then for this one —
   * read on every request, so a change in Settings applies from the next step.
   */
  instructions?: () => { global: string; session: string }
}

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

/** The default context budget stays put for models whose real window is
 * unknown; a known bigger window (Gemini 1M, GLM 200k) lets the history run
 * longer before compaction replaces old turns with a memory. */
const KNOWN_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['gemini-2.5-pro', 1_000_000],
  ['gemini-2.5-flash', 1_000_000],
  ['gemini-2.0-flash', 1_000_000],
  ['glm-4.6', 200_000],
  ['glm-4.5', 128_000],
  ['glm-5.3-flash', 200_000]
])

/** Headroom for the model's own reply and the next tool results. */
const REPLY_HEADROOM = 24_000

export function historyBudgetFor(model: string): number {
  const base = KNOWN_CONTEXT_WINDOWS.get(model)
  if (base === undefined) return HISTORY_TOKEN_BUDGET
  return Math.max(HISTORY_TOKEN_BUDGET, base - REPLY_HEADROOM)
}

const isToolUse = (block: ContentBlock): block is ToolUseBlock => block.type === 'tool_use'

function describeError(error: unknown, provider?: LLMProvider): string {
  const message = error instanceof Error ? error.message : String(error)
  // Fetch reports a dropped stream in one bare word; say what happened. The
  // word also marks a transient network cut, not a wrong configuration, so
  // the wording asks for a retry rather than sending the user to settings.
  if (/^(terminated|fetch failed|connection error|socket hang up|other side closed)$/i.test(message.trim())) {
    const name = provider?.name === undefined ? 'the provider' : provider.name
    return `Connection to ${name} dropped (${message.trim()}). The run was stopped; press Continue to pick it up — if it keeps failing, check your internet connection, not the provider settings.`
  }
  // Retrying a spent quota only fails again; name the way out.
  if (isOutOfUsage(error)) {
    return `${message}\nThis model is out of usage. Pick another model from the model chip, or top up the account.`
  }
  return message
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
const RETRYABLE_CODES = new Set([
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETDOWN',
  'ENETUNREACH', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'
])

export function isTransient(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    const record = current as { status?: unknown; code?: unknown; message?: unknown; cause?: unknown; error?: unknown }
    if (typeof record.status === 'number' &&
      (record.status === 408 || record.status === 429 || (record.status >= 500 && record.status <= 599))) return true
    if (typeof record.code === 'string' && RETRYABLE_CODES.has(record.code.toUpperCase())) return true
    if (typeof record.message === 'string' &&
      /fetch failed|terminated|other side closed|network|connection (?:lost|reset|refused)|socket|timed? ?out|timeout|temporarily unavailable/i.test(record.message)) return true
    current = record.cause ?? record.error
  }
  return false
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
    case 'display':
      return 0
  }
}

export class AgentSession {
  private readonly history: Message[] = []
  private readonly transcript: Message[] = []
  private running = false
  /** A fixed kit (a sub-agent's); otherwise the mode's tools, asked for fresh each step. */
  private readonly fixedTools: Tool[] | null
  /** Images produced by tools this turn; appended after their tool results. */
  private pendingImages: ContentBlock[] = []
  /**
   * The reply the model is writing right now, as far as it got. A pause that
   * lands mid-reply keeps it in the history, so a resume carries on from its
   * last word instead of paying to write the whole reply again.
   */
  private streamed = ''
  private projectInstructions: string | null | undefined
  /** Instructions sent while a run was working, waiting for its next step. */
  private followUps: FollowUp[] = []
  private activeSignal: AbortSignal | null = null
  /** Rotation only: who takes a turn the current provider could not serve. */
  private fallback: ProviderFallback | null = null
  /** Before-images of what each run changed; null without a folder to change. */
  private readonly checkpoints: CheckpointStore | null

  constructor(
    private provider: LLMProvider,
    private readonly gate: ApprovalGate,
    private readonly mode: SessionMode = 'code',
    private readonly workspaceRoot: string | null = null,
    initialHistory: Message[] = [],
    private readonly scope: string = randomUUID(),
    private readonly options: AgentOptions = {}
  ) {
    this.fixedTools = options.tools ?? null
    // A sub-agent only reads; it has nothing to take back.
    this.checkpoints =
      workspaceRoot === null || options.subagent === true
        ? null
        : new CheckpointStore(options.checkpointDir ?? path.join(tmpdir(), 'anticode-checkpoints', randomUUID()), workspaceRoot)
    const restored = structuredClone(initialHistory)
    this.transcript.push(...restored)
    this.history.push(...restored.flatMap((message) => {
      const content = message.content.filter((block) => block.type !== 'display')
      return content.length === 0 ? [] : [{ ...message, content }]
    }))
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

  /** What the model is offered now — MCP servers may have come or gone since the last step. */
  private toolset(): Tool[] {
    return this.fixedTools ?? toolsFor(this.mode)
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
    this.checkpoints?.begin(this.transcript.length)
    this.record({
      role: 'user',
      content: [...(params.attachments ?? []), { type: 'text', text: prompt }]
    })

    let steps = 0
    let repeatedToolRounds = 0
    let previousToolRound = ''
    try {
      for (;;) {
        if (signal.aborted) break
        steps += 1
        const stepLimit = this.options.subagent === true ? SUBAGENT_MAX_STEPS : AGENT_MAX_STEPS
        const graceSteps = this.options.subagent === true ? SUBAGENT_GRACE_STEPS : AGENT_GRACE_STEPS
        if (steps > stepLimit + graceSteps) {
          emit({ type: 'end', runId, reason: 'max_tokens' })
          return
        }

        this.condenseHistory()
        await this.compactHistory(params)
        const response = await this.requestTurn(params)
        this.record({ role: 'assistant', content: response.content })
        emit({
          type: 'usage',
          runId,
          provider: this.provider.name,
          ...(this.provider.id !== undefined ? { providerId: this.provider.id } : {}),
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
        const limit: ContentBlock[] = steps >= stepLimit
          ? [{ type: 'text', text: '[Step limit reached. Do not call any more tools — write your final report now.]' }]
          : []
        this.record({ role: 'user', content: [...results, ...this.pendingImages, ...added, ...limit] })
        this.pendingImages = []

        const toolRound = JSON.stringify(calls.map((call, index) => ({
          name: call.name,
          input: call.input,
          result: results[index]?.type === 'tool_result'
            ? {
                content: results[index].content,
                isError: results[index].isError,
                diff: results[index].diff
              }
            : results[index]
        })))
        repeatedToolRounds = toolRound === previousToolRound ? repeatedToolRounds + 1 : 1
        previousToolRound = toolRound
        if (calls.length > 0 && repeatedToolRounds >= MAX_IDENTICAL_TOOL_ROUNDS) {
          throw new Error(
            `Stopped a repeated tool loop: the same ${calls.length === 1 ? calls[0]?.name ?? 'tool' : 'tool calls'} and result occurred ${MAX_IDENTICAL_TOOL_ROUNDS} times in a row.`
          )
        }
      }
    } catch (error) {
      this.pendingImages = []
      this.sealPendingToolUses()
      const retryable = !signal.aborted && !isOutOfUsage(error) && isTransient(error)
      const kept = (signal.aborted || retryable) ? this.keepInterruptedReply() : null
      const keptReply = kept !== null ? { keptReplyModel: this.provider.model } : {}
      if (kept !== null) {
        // Streaming APIs normally report usage only in their final chunk. A
        // pause cuts that chunk off, so retain an honest estimate instead of 0.
        emit({
          type: 'usage', runId, provider: this.provider.name,
          ...(this.provider.id !== undefined ? { providerId: this.provider.id } : {}),
          model: this.provider.model,
          inputTokens: Math.max(1, replayCost(this.history) - Math.ceil(kept.length / 4)),
          outputTokens: Math.max(1, Math.ceil(kept.length / 4)),
          estimated: true
        })
      }
      const described = describeError(error, this.provider)
      this.recordDisplay(signal.aborted ? 'notice' : 'error', signal.aborted ? 'Paused.' : described)
      if (signal.aborted) {
        emit({ type: 'end', runId, reason: 'cancelled', ...keptReply })
      } else {
        emit({
          type: 'error', runId, message: described,
          ...(retryable ? { retryable: true } : {}),
          ...keptReply
        })
      }
      return
    }

    this.pendingImages = []
    this.sealPendingToolUses()
    this.recordDisplay('notice', 'Paused.')
    emit({ type: 'end', runId, reason: 'cancelled' })
  }

  private async requestTurn(params: RunParams): Promise<LLMResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.streamTurn(params)
      } catch (error) {
        if (params.signal.aborted) throw error
        // Words already shown cannot be taken back: another attempt — or
        // another model — would write its whole reply after them. The run
        // stops instead; the words are kept and Continue carries on from them.
        if (this.streamed !== '') throw error
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
    this.streamed = ''

    const iterator = this.provider.chat({
      system: this.systemPrompt(), messages: this.history,
      tools: definitionsOf(this.toolset()),
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
        if (event.type === 'text_delta') {
          this.streamed += event.text
          params.emit({ type: 'text_delta', runId: params.runId, text: event.text })
        }
        else response = event.response
      }
    } finally {
      params.signal.removeEventListener('abort', onAbort)
      // Some SDK iterators do not settle next() promptly on abort. Do not make
      // stopping the run depend on their iterator.return() finishing first.
      void iterator.return?.().catch(() => undefined)
    }

    if (!response) throw new Error('Provider returned no response')
    // Finished, it is recorded whole; only a reply cut off is kept from here.
    this.streamed = ''
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
   * Once the replayed history would blow past the context budget, the oldest
   * prompt turns are replaced by a memory the model writes of them — goals,
   * decisions, files, results, state. The cut lands on plain user prompts only,
   * never between an assistant tool_use and its tool_result, which providers
   * reject; and it leaves headroom, so the next steps do not compact again.
   */
  private async compactHistory(params: RunParams): Promise<void> {
    // The budget is the model's own window when it is known (Gemini 1M, GLM
    // 200k...), and the shared default otherwise — so big-window models stop
    // compacting long before their real limit.
    const budget = historyBudgetFor(this.provider.model)
    const compactTarget = Math.floor(budget * 0.72)
    const before = replayCost(this.history)
    if (before <= budget) return

    const suffixCosts: number[] = new Array(this.history.length)
    let running = 0
    for (let i = this.history.length - 1; i >= 0; i--) {
      running += messageCost(this.history[i] ?? { role: 'user', content: [] })
      suffixCosts[i] = running
    }
    const boundaries = this.history.flatMap((message, index) => isPlainPrompt(message) ? [index] : [])
    const fits = (limit: number): number | undefined =>
      boundaries.find((index) => (suffixCosts[index] ?? Infinity) <= limit)
    const cut = fits(compactTarget) ?? fits(budget) ?? -1

    // Do not repeatedly send an oversized single turn to the provider. A new
    // user prompt supplies a safe boundary for the next continuation.
    if (cut < 0) throw new Error('This turn exceeds the context budget. Send a shorter continuation or start a new session.')
    if (cut === 0) return
    await this.replaceWithMemory(cut, compactTarget, params.signal, (usage) => params.emit({
      type: 'usage',
      runId: params.runId,
      provider: this.provider.name,
      ...(this.provider.id !== undefined ? { providerId: this.provider.id } : {}),
      model: this.provider.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      subagent: true
    }))
    params.emit({
      type: 'notice',
      runId: params.runId,
      text: `context compacted · ${before.toLocaleString('en-US')} → ${replayCost(this.history).toLocaleString('en-US')} tokens`
    })
  }

  /**
   * Compacts on request, between runs: everything before the latest prompt
   * becomes one memory. Returns the replay estimate before and after.
   */
  async compact(signal: AbortSignal, onUsage?: (usage: Usage) => void): Promise<{ before: number; after: number }> {
    if (this.running) throw new Error('Pause this session before compacting it')
    this.running = true
    try {
      const before = replayCost(this.history)
      let cut = -1
      for (let i = this.history.length - 1; i > 0; i--) {
        if (isPlainPrompt(this.history[i])) { cut = i; break }
      }
      // Only the memory itself precedes the latest prompt: nothing new to fold.
      const alreadyCompact = cut === 1 && isMemory(this.history[0])
      if (cut > 0 && !alreadyCompact) await this.replaceWithMemory(cut, DEFAULT_COMPACTION_TARGET, signal, onUsage)
      return { before, after: replayCost(this.history) }
    } finally {
      this.running = false
    }
  }

  private async replaceWithMemory(cut: number, compactTarget: number, signal: AbortSignal, onUsage?: (usage: Usage) => void): Promise<void> {
    const memory = await this.writeMemory(this.history.slice(0, cut), signal, onUsage)
    this.history.splice(0, cut)
    if (memory === '') return
    this.history.unshift({ role: 'user', content: [{ type: 'text', text: `${MEMORY_HEADER}\n${memory}` }] })
    // A verbose summary must never put replay back over the cliff.
    while (this.history.length > 1 && replayCost(this.history) > compactTarget) {
      const boundary = this.history.findIndex((message, index) => index > 1 && isPlainPrompt(message))
      if (boundary < 0) break
      this.history.splice(1, boundary - 1)
    }
  }

  /**
   * The memory of the dropped turns, written by the session's own model. A
   * provider that fails, stalls, or answers nothing gets the deterministic
   * digest instead — compaction must never be what stops a run.
   */
  private async writeMemory(removed: Message[], signal: AbortSignal, onUsage?: (usage: Usage) => void): Promise<string> {
    const digest = summariseMessages(removed)
    if (digest === '') return ''
    const limited = AbortSignal.any([signal, AbortSignal.timeout(COMPACTION_TIMEOUT_MS)])
    try {
      const response = await collectResponse(
        this.provider.chat({
          system: COMPACTION_SYSTEM,
          messages: [{ role: 'user', content: [{ type: 'text', text: compactionMaterial(removed) }] }],
          tools: [],
          maxTokens: COMPACTION_MAX_TOKENS,
          signal: limited
        }),
        limited
      )
      onUsage?.(response.usage)
      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
        .trim()
      if (text === '') return digest
      return text.length > MEMORY_MAX_CHARS * 2 ? `${text.slice(0, MEMORY_MAX_CHARS * 2)}\n…` : text
    } catch {
      signal.throwIfAborted()
      return digest
    }
  }

  private async executeCalls(calls: ToolUseBlock[], params: RunParams): Promise<ContentBlock[]> {
    const results = new Array<ContentBlock | undefined>(calls.length)
    const entries = calls.map((call, index) => ({ call, index }))
    const byName = new Map(this.toolset().map((tool) => [tool.name, tool]))
    const isReadOnly = (name: string): boolean => byName.get(name)?.readOnly === true

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
    // Only the tools this mode offers: a name the model invents runs nothing.
    const tool = this.toolset().find((entry) => entry.name === call.name)
    if (!tool) {
      return this.finishCall(params, call.id, `Unknown tool: ${call.name}`, true)
    }

    if (this.workspaceRoot === null) {
      return this.finishCall(params, call.id, 'This session has no file access.', true)
    }
    const context = {
      workspaceRoot: this.workspaceRoot,
      signal: params.signal,
      sessionId: this.scope,
      // One level deep: a sub-agent has no `task` tool, and no delegate either.
      ...(this.options.subagent === true
        ? {}
        : { delegate: (task: DelegatedTask) => this.runSubagent(task, call.id, params) })
    }

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
      if (params.signal.aborted) {
        return this.finishCall(
          params,
          call.id,
          'Paused before approval; the user did not reject this tool.',
          false
        )
      }
      if (!approved) {
        return this.finishCall(params, call.id, 'Rejected by the user.', true, true)
      }

      params.signal.throwIfAborted()
      const scan = await this.captureCheckpoint(tool, call)
      let output: Awaited<ReturnType<typeof prepared.execute>>
      try {
        output = await prepared.execute(context)
      } finally {
        // A command that failed halfway may still have changed files.
        if (scan !== null) await this.checkpoints?.afterCommand(scan).catch(() => undefined)
      }
      this.pendingImages.push(
        ...output.images.map((image) => ({
          type: 'image' as const,
          mediaType: image.mediaType,
          data: image.data
        }))
      )
      return this.finishCall(params, call.id, truncate(output.text), output.isError === true, false, output.diff)
    } catch (error) {
      return this.finishCall(params, call.id, describeError(error), true)
    }
  }

  /**
   * Runs one `task` in a child session: same model, same folder, a fresh
   * history, read-only tools. Its steps are reported as progress on the call
   * that started it and its tokens count toward this run, but only its final
   * report comes back — that is what keeps the parent's context small.
   */
  private async runSubagent(task: DelegatedTask, toolUseId: string, params: RunParams): Promise<string> {
    const child = new AgentSession(this.provider, this.gate, 'code', this.workspaceRoot, [], this.scope, {
      tools: subagentTools(),
      subagent: true
    })
    child.projectInstructions = this.loadProjectInstructions()
    let calls = 0
    // Held in an object: assignments inside the emit callback are invisible to
    // control-flow narrowing, which would otherwise pin it to null.
    const outcome: { failure: string | null } = { failure: null }
    await child.run({
      runId: params.runId,
      prompt: task.prompt,
      signal: params.signal,
      emit: (event) => {
        if (event.type === 'tool_start') {
          calls += 1
          params.emit({ type: 'tool_progress', runId: params.runId, toolUseId, text: `${event.name} ${subjectOf(event.input)}`.trim() })
        } else if (event.type === 'usage') {
          params.emit({ ...event, subagent: true })
        } else if (event.type === 'error') {
          outcome.failure = event.message
        } else if (event.type === 'end' && event.reason !== 'complete') {
          outcome.failure = event.reason === 'max_tokens' ? 'step limit reached' : event.reason
        }
      }
    })
    params.signal.throwIfAborted()
    const { failure } = outcome
    const report = finalText(child.transcript)
    if (report === '') throw new ToolError(`Sub-agent "${task.description}" returned no report${failure !== null ? `: ${failure}` : ''}`)
    const note = failure !== null ? ` · stopped early: ${failure}` : ''
    return `${report}\n\n[sub-agent · ${calls} tool ${calls === 1 ? 'call' : 'calls'}${note}]`
  }

  private finishCall(
    params: RunParams,
    toolUseId: string,
    output: string,
    isError: boolean,
    rejected = false,
    diff?: string
  ): ContentBlock {
    params.emit({
      type: 'tool_end',
      runId: params.runId,
      toolUseId,
      ok: !isError,
      output,
      ...(rejected ? { rejected: true } : {}),
      ...(diff !== undefined ? { diff } : {})
    })
    return { type: 'tool_result', toolUseId, content: output, isError, ...(diff !== undefined ? { diff } : {}) }
  }

  /**
   * Stopped while the model was writing: what it wrote so far stays, as its
   * turn, so a resume continues it rather than starting it over. A tool call
   * it was halfway through spelling out cannot be kept — its arguments are cut
   * off — but the words before it are.
   */
  private keepInterruptedReply(): string | null {
    const said = this.streamed.trim()
    this.streamed = ''
    if (said === '' || this.history.at(-1)?.role !== 'user') return null
    this.record({ role: 'assistant', content: [{ type: 'text', text: said }] })
    return said
  }

  /** Adds durable UI state without feeding it back to the model. */
  private recordDisplay(kind: 'notice' | 'error', text: string): void {
    const last = this.transcript.at(-1)
    if (last?.role === 'assistant') {
      this.transcript[this.transcript.length - 1] = {
        ...last,
        content: [...last.content, { type: 'display', kind, text }]
      }
      return
    }
    this.transcript.push({ role: 'assistant', content: [{ type: 'display', kind, text }] })
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
      this.cutAt(i)
      return text.text
    }
    return null
  }

  /**
   * Takes back the `count`-th typed prompt from the end and everything after
   * it — replies, later prompts, and the files their runs changed — and hands
   * that prompt back whole, attachments included, to edit or send again.
   * Follow-ups and resumes are not typed prompts: they ride with the prompt
   * before them. Null when there are not that many prompts.
   */
  takeBack(count: number): TakenBack | null {
    if (this.running) throw new Error('Pause this session before editing its prompts')
    let seen = 0
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const message = this.transcript[i]
      if (message === undefined || !isTypedPrompt(message)) continue
      seen += 1
      if (seen < count) continue
      const typed = message.content.find(
        (block): block is Extract<ContentBlock, { type: 'text' }> =>
          block.type === 'text' && block.attachment === undefined && block.followUp === undefined
      )
      if (typed === undefined) return null
      const removed = this.transcript.slice(i)
      this.cutAt(i)
      return {
        prompt: typed.text,
        attachments: message.content.filter((block) => block !== typed),
        removed
      }
    }
    return null
  }

  /**
   * Cuts the record at transcript index `index` and the replay at the same
   * message. A prompt the replay still holds is the very object the record
   * holds (prompts are never condensed), so it is found by identity; one that
   * compaction folded away takes the replay back to the plain record, which
   * the next run compacts again if it has to. The files go back too.
   */
  private cutAt(index: number): void {
    const target = this.transcript[index]
    this.transcript.length = index
    const replayed = target === undefined ? -1 : this.history.indexOf(target)
    if (replayed >= 0) this.history.length = replayed
    else this.history.splice(0, this.history.length, ...this.transcript)
    this.checkpoints?.restoreFrom(index)
  }

  private record(message: Message): void { this.history.push(message); this.transcript.push(message) }

  /**
   * Keeps what a mutating tool is about to change, once per run: the paths it
   * names (edit, write, delete, Excel, Word, PDF), or — for a shell command,
   * which names none — a scan of the workspace to compare against afterwards.
   */
  private async captureCheckpoint(tool: Tool, call: ToolUseBlock): Promise<WorkspaceScan | null> {
    if (this.checkpoints === null || tool.readOnly) return null
    try {
      if (tool.name === 'run_command') return await this.checkpoints.beforeCommand()
      const input = call.input as { path?: unknown; output_path?: unknown } | null
      for (const target of [input?.path, input?.output_path]) {
        if (typeof target === 'string' && target.trim() !== '') this.checkpoints.capture(target)
      }
    } catch {
      // A checkpoint that cannot be written must not stop the work itself.
    }
    return null
  }

  /** The session is deleted: its checkpoints go with it. */
  discardCheckpoints(): void {
    this.checkpoints?.destroy()
  }

  dispose(): void { void closeBrowser(this.scope) }

  /** A copy of the replayed history, for the remote API and dashboards. */
  snapshot(): { messages: Message[] } {
    return { messages: structuredClone(this.transcript) }
  }

  get contextTokens(): number { return replayCost(this.history) }

  private systemPrompt(): string {
    const base = this.basePrompt()
    const given = this.options.instructions?.()
    const sections = [
      ...(given !== undefined && given.global.trim() !== '' ? [`Instructions from the user, for every session:\n\n${given.global.trim()}`] : []),
      ...(given !== undefined && given.session.trim() !== '' ? [`Instructions from the user, for this session:\n\n${given.session.trim()}`] : [])
    ]
    return sections.length === 0 ? base : [base, ...sections].join('\n\n')
  }

  private basePrompt(): string {
    if (this.options.subagent === true) {
      const lines = [
        'You are a sub-agent of anticode, sent by the main agent to investigate one question in a project folder.',
        `Workspace root: ${this.workspaceRoot}`,
        `Operating system: ${process.platform}`,
        '',
        'Rules:',
        '- You can only read: files, folders, workspace search, Excel/Word/PDF, and URLs. You cannot edit or run anything.',
        '- Every path is relative to the workspace root. Search before reading; issue independent calls together.',
        '- Nobody can answer questions from you. Make reasonable assumptions and note them.',
        '- Stop as soon as you can answer. Your final reply is your report, and it is all the main agent sees: ' +
          'it cannot see the files you read. Make it self-contained and concise — findings, file paths with line ' +
          'numbers, relevant snippets, and anything you could not confirm.',
        '- Do not use emojis or decorative symbols.'
      ]
      const instructions = this.loadProjectInstructions()
      if (instructions !== null) lines.push('', `Rules from the project:\n\n${instructions}`)
      return lines.join('\n')
    }
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
          'the desktop and the phone, so say what you changed instead of pasting the file back. ' +
          'To hand back a file you did not write — an attachment as it is — call share_file on it.',
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
      '- For broad exploration across many files, delegate to the task tool — several task calls in one turn ' +
        'run in parallel — and keep your own context for the work itself.',
      '- Check that a tool or dependency already exists before installing or re-running it.',
      '- Stop as soon as the task succeeds; do not re-run commands to double-check.',
      '- If a tool fails, read its error message and adjust your approach.',
      '- Files the user attaches from outside the project are copied into .anticode/uploads/. ' +
        'To change one, work on that copy.',
      '- A file reaches the user as a downloadable card only in two ways: a document ' +
        '(.pdf, .xlsx, .xlsm, .docx, .csv, .pptx, .zip) written successfully by one of your tools, or a ' +
        'share_file call. Anything else — source files, files copied or built with run_command — is ' +
        'invisible to the user until you call share_file on it. ' +
        'When the user wants to get or open a file, call share_file; never say a file is shown or ' +
          'downloadable unless one of those calls succeeded in this turn. Download cards render below your reply, ' +
          'so refer to “the file card below”, never “above”.',
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

/** What a sub-agent step was about, for its one-line progress entry. */
function subjectOf(input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of ['path', 'query', 'pattern', 'url']) {
    const value = record[key]
    if (typeof value === 'string') return value.slice(0, 160)
  }
  return ''
}

/** The words of the last assistant turn that said anything. */
function finalText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return ''
}

/** A user turn that is a prompt, not tool results: the only safe place to cut. */
function isPlainPrompt(message: Message | undefined): boolean {
  return message?.role === 'user' && !message.content.some((block) => block.type === 'tool_result')
}

function isMemory(message: Message | undefined): boolean {
  const first = message?.content[0]
  return message?.role === 'user' && first?.type === 'text' && first.text.startsWith(MEMORY_HEADER)
}

/**
 * Drains a provider stream to its final response, without trusting its
 * iterator to notice an abort (some SDK iterators never settle on one).
 */
async function collectResponse(stream: AsyncIterable<ProviderEvent>, signal: AbortSignal): Promise<LLMResponse> {
  const iterator = stream[Symbol.asyncIterator]()
  let rejectAbort: (reason: unknown) => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => rejectAbort(new Error('aborted'))
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    signal.throwIfAborted()
    let response: LLMResponse | null = null
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted])
      if (next.done) break
      if (next.value.type === 'response') response = next.value.response
    }
    if (response === null) throw new Error('Provider returned no response')
    return response
  } finally {
    signal.removeEventListener('abort', onAbort)
    void iterator.return?.().catch(() => undefined)
  }
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n… [${text.length - max} characters omitted] …\n${text.slice(-half)}`
}

/** The dropped turns as the model reads them to write the memory. */
function compactionMaterial(messages: Message[]): string {
  const parts: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') {
        const who = message.role === 'user' ? (block.attachment !== undefined ? 'USER (attachment)' : 'USER') : 'ASSISTANT'
        parts.push(`${who}: ${clip(block.followUp?.text ?? block.text, 6_000)}`)
      } else if (block.type === 'tool_use') {
        parts.push(`TOOL CALL ${block.name}: ${clip(JSON.stringify(block.input ?? {}), 800)}`)
      } else if (block.type === 'tool_result') {
        parts.push(`TOOL RESULT${block.isError ? ' (error)' : ''}: ${clip(block.content, 1_500)}`)
      } else if (block.type === 'image') {
        parts.push('[image]')
      }
    }
  }
  let body = parts.join('\n\n')
  if (body.length > COMPACTION_INPUT_CHARS) body = `[… the earliest part is omitted …]\n\n${body.slice(-COMPACTION_INPUT_CHARS)}`
  return `Write the memory of this conversation.\n\n<conversation>\n${body}\n</conversation>`
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
