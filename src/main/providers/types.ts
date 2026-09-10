import type { AttachmentRef } from '@shared/ipc'

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal'

/**
 * `opaque` carries provider-native blocks that must be replayed verbatim to the
 * same provider — Anthropic thinking blocks are signed and rejected if altered.
 * Blocks from a different provider are dropped rather than translated.
 */
export type ContentBlock =
  /**
   * `attachment` is carried for the UI only — providers read `text` and ignore
   * the rest. It rides on the header block of a user attachment so a reopened
   * transcript can redraw the file card, even after the image itself was
   * elided from the replayed history.
   */
  | {
      type: 'text'
      text: string
      attachment?: AttachmentRef
      /**
       * An instruction the user sent while the run was working. `text` is what
       * the model reads (the words, framed as an addition to the task); this is
       * the words as typed, for viewers. `during` is false when the run was
       * paused before it could take the instruction in.
       */
      followUp?: { text: string; during: boolean }
    }
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'opaque'; provider: string; raw: unknown }

export interface Message {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export interface LLMResponse {
  content: ContentBlock[]
  stopReason: StopReason
  usage: Usage
}

export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'response'; response: LLMResponse }

export interface ChatParams {
  system: string
  messages: Message[]
  tools: ToolDefinition[]
  maxTokens: number
  signal: AbortSignal
}

export interface LLMProvider {
  readonly name: string
  readonly model: string
  chat(params: ChatParams): AsyncIterable<ProviderEvent>
}
