import Anthropic from '@anthropic-ai/sdk'
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

const PROVIDER_NAME = 'anthropic'

function toBlockParam(block: ContentBlock): Anthropic.ContentBlockParam | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'image':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mediaType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
          data: block.data
        }
      }
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError
      }
    case 'opaque':
      return block.provider === PROVIDER_NAME
        ? (block.raw as Anthropic.ContentBlockParam)
        : null
  }
}

function toMessageParams(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
      .map(toBlockParam)
      .filter((block): block is Anthropic.ContentBlockParam => block !== null)
  }))
}

function toToolParams(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema
  }))
}

function fromContentBlock(block: Anthropic.ContentBlock): ContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (block.type === 'tool_use') {
    return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
  }
  return { type: 'opaque', provider: PROVIDER_NAME, raw: block }
}

function toStopReason(reason: Anthropic.Message['stop_reason']): StopReason {
  if (reason === 'tool_use') return 'tool_use'
  if (reason === 'max_tokens') return 'max_tokens'
  if (reason === 'refusal') return 'refusal'
  return 'end_turn'
}

export class AnthropicProvider implements LLMProvider {
  readonly name = PROVIDER_NAME

  private readonly client: Anthropic

  constructor(
    apiKey: string,
    readonly model: string
  ) {
    this.client = new Anthropic({ apiKey })
  }

  async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: params.maxTokens,
        system: params.system,
        tools: toToolParams(params.tools),
        messages: toMessageParams(params.messages)
      },
      { signal: params.signal }
    )

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text_delta', text: event.delta.text }
      }
    }

    const final = await stream.finalMessage()
    const response: LLMResponse = {
      content: final.content.map(fromContentBlock),
      stopReason: toStopReason(final.stop_reason),
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens
      }
    }
    yield { type: 'response', response }
  }
}
