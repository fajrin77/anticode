import type { AgentEvent, SessionMode } from '@shared/ipc'
import type { ContentBlock, LLMProvider, LLMResponse, Message } from '../providers/types'
import { toolDefinitions, tools } from '../tools'
import type { Tool } from '../tools'
import type { ApprovalGate } from '../approval/types'

const MAX_TOKENS = 32_000
const MAX_TOOL_OUTPUT = 30_000

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
  if (output === '') return '(tanpa keluaran)'
  return output.length > MAX_TOOL_OUTPUT
    ? `${output.slice(0, MAX_TOOL_OUTPUT)}\n… hasil dipotong (${output.length} karakter total)`
    : output
}

export class AgentSession {
  private readonly history: Message[] = []
  private readonly byName = new Map<string, Tool>(tools.map((tool) => [tool.name, tool]))
  /** Images produced by tools this turn; appended after their tool results. */
  private pendingImages: ContentBlock[] = []

  constructor(
    private readonly provider: LLMProvider,
    private readonly gate: ApprovalGate,
    private readonly mode: SessionMode = 'code',
    private readonly workspaceRoot: string | null = null
  ) {}

  async run(params: RunParams): Promise<void> {
    const { runId, prompt, signal, emit } = params
    this.history.push({
      role: 'user',
      content: [...(params.attachments ?? []), { type: 'text', text: prompt }]
    })

    try {
      for (;;) {
        if (signal.aborted) break

        const response = await this.requestTurn(params)
        this.history.push({ role: 'assistant', content: response.content })
        emit({
          type: 'usage',
          runId,
          provider: this.provider.name,
          model: this.provider.model,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens
        })

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
        this.history.push({ role: 'user', content: [...results, ...this.pendingImages] })
        this.pendingImages = []
      }
    } catch (error) {
      this.sealPendingToolUses()
      if (signal.aborted) {
        emit({ type: 'end', runId, reason: 'cancelled' })
      } else {
        emit({ type: 'error', runId, message: describeError(error) })
      }
      return
    }

    this.sealPendingToolUses()
    emit({ type: 'end', runId, reason: 'cancelled' })
  }

  private async requestTurn(params: RunParams): Promise<LLMResponse> {
    let response: LLMResponse | null = null

    for await (const event of this.provider.chat({
      system: this.systemPrompt(),
      messages: this.history,
      // Chat mode is offered no tools at all, so the model cannot reach the disk.
      tools: this.mode === 'code' ? toolDefinitions() : [],
      maxTokens: MAX_TOKENS,
      signal: params.signal
    })) {
      if (event.type === 'text_delta') {
        params.emit({ type: 'text_delta', runId: params.runId, text: event.text })
      } else {
        response = event.response
      }
    }

    if (!response) throw new Error('Provider tidak mengembalikan respons')
    return response
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

    const tool = this.byName.get(call.name)
    if (!tool) {
      return this.finishCall(params, call.id, `Tool tidak dikenal: ${call.name}`, true)
    }

    if (this.workspaceRoot === null) {
      return this.finishCall(params, call.id, 'Sesi ini tidak punya akses berkas.', true)
    }
    const context = { workspaceRoot: this.workspaceRoot, signal: params.signal }

    try {
      const prepared = tool.prepare(call.input)

      const approved = await this.gate.authorize({
        runId,
        toolName: tool.name,
        risk: prepared.risk,
        preview: () => prepared.preview(context),
        signal: params.signal
      })
      if (!approved) {
        return this.finishCall(params, call.id, 'Ditolak oleh pengguna.', true, true)
      }

      const output = await prepared.execute(context)
      this.pendingImages.push(
        ...output.images.map((image) => ({
          type: 'image' as const,
          mediaType: image.mediaType,
          data: image.data
        }))
      )
      return this.finishCall(params, call.id, truncate(output.text), false)
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

    this.history.push({
      role: 'user',
      content: pending.map((block) => ({
        type: 'tool_result' as const,
        toolUseId: block.id,
        content: 'Dibatalkan oleh pengguna sebelum tool dijalankan.',
        isError: true
      }))
    })
  }

  private systemPrompt(): string {
    if (this.mode === 'chat') {
      return [
        'Kamu adalah antichat, mode tanya jawab dari anticode.',
        'Kamu tidak punya akses ke berkas, terminal, maupun jaringan.',
        'Jika pengguna meminta sesuatu yang butuh membaca atau mengubah berkas, katakan bahwa ' +
          'itu perlu sesi anticode yang terhubung ke folder project.',
        'Jawab dalam bahasa yang dipakai pengguna, ringkas dan langsung ke inti.'
      ].join('\n')
    }

    return [
      'Kamu adalah anticode, agent coding yang bekerja di dalam satu folder project milik pengguna.',
      `Root workspace: ${this.workspaceRoot}`,
      `Sistem operasi: ${process.platform}`,
      '',
      'Aturan kerja:',
      '- Semua path yang kamu berikan ke tool bersifat relatif terhadap root workspace.',
      '- Baca berkas sebelum mengubahnya; jangan menebak isinya.',
      '- Untuk perubahan sebagian, pakai edit_file, bukan write_file.',
      '- Jika sebuah tool gagal, baca pesan errornya dan perbaiki pendekatanmu.',
      '- Jawab dalam bahasa yang dipakai pengguna, ringkas dan langsung ke inti.'
    ].join('\n')
  }
}
