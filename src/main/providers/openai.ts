import OpenAI from 'openai'
import type {
  ChatParams,
  ContentBlock,
  LLMProvider,
  LLMResponse,
  Message,
  ProviderEvent,
  StopReason,
  ToolDefinition
} from './types'

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

/**
 * Anthropic groups every tool result into one user message; OpenAI wants one
 * message per result with role "tool". Splitting them is this adapter's job.
 */
function toChatMessages(system: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }]

  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      const toolCalls = message.content.filter((block) => block.type === 'tool_use')

      out.push({
        role: 'assistant',
        content: text === '' ? null : text,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((block) => ({
                id: block.id,
                type: 'function' as const,
                function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
              }))
            }
          : {})
      })
      continue
    }

    for (const block of message.content) {
      if (block.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content })
      }
    }

    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = []
    for (const block of message.content) {
      if (block.type === 'text' && block.text !== '') {
        parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${block.mediaType};base64,${block.data}` }
        })
      }
    }
    if (parts.length > 0) out.push({ role: 'user', content: parts })
  }

  return out
}

function toChatTools(tools: ToolDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }))
}

function toStopReason(reason: string | null | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls || reason === 'tool_calls') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'content_filter') return 'refusal'
  return 'end_turn'
}

function parseArguments(raw: string): unknown {
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    // Surfaced to the model as a tool input validation error rather than crashing.
    return { __malformed_arguments: raw }
  }
}

export class OpenAICompatibleProvider implements LLMProvider {
  private readonly client: OpenAI

  constructor(
    readonly name: string,
    readonly model: string,
    options: { apiKey: string; baseURL?: string; maxTokensField: 'max_completion_tokens' | 'max_tokens' }
  ) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {})
    })
    this.maxTokensField = options.maxTokensField
  }

  private readonly maxTokensField: 'max_completion_tokens' | 'max_tokens'

  async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: toChatMessages(params.system, params.messages),
        tools: toChatTools(params.tools),
        stream: true,
        stream_options: { include_usage: true },
        [this.maxTokensField]: params.maxTokens
      },
      { signal: params.signal }
    )

    let text = ''
    let finishReason: string | null = null
    const usage = { inputTokens: 0, outputTokens: 0 }
    const calls = new Map<number, { id: string; name: string; args: string }>()

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens
        usage.outputTokens = chunk.usage.completion_tokens
      }

      const choice = chunk.choices[0]
      if (!choice) continue
      if (choice.finish_reason) finishReason = choice.finish_reason

      const delta = choice.delta.content
      if (typeof delta === 'string' && delta !== '') {
        text += delta
        yield { type: 'text_delta', text: delta }
      }

      for (const call of choice.delta.tool_calls ?? []) {
        const existing = calls.get(call.index) ?? { id: '', name: '', args: '' }
        calls.set(call.index, {
          id: call.id ?? existing.id,
          name: call.function?.name ?? existing.name,
          args: existing.args + (call.function?.arguments ?? '')
        })
      }
    }

    const content: ContentBlock[] = []
    if (text !== '') content.push({ type: 'text', text })
    for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      content.push({
        type: 'tool_use',
        id: call.id !== '' ? call.id : `call_${index}`,
        name: call.name,
        input: parseArguments(call.args)
      })
    }

    const response: LLMResponse = {
      content,
      stopReason: toStopReason(finishReason, calls.size > 0),
      usage
    }
    yield { type: 'response', response }
  }
}
