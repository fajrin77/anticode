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

/**
 * The SDK adds /v1 itself; a Base URL pasted with it would call /v1/v1/…
 * and every request would come back 404.
 */
export function anthropicBaseURL(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

/** Each model's own output ceiling, asked of the Models API once per key and model. */
const outputCaps = new Map<string, Promise<number | null>>()

export class AnthropicProvider implements LLMProvider {
  readonly name = PROVIDER_NAME

  private readonly client: Anthropic
  private readonly capKey: string

  constructor(
    apiKey: string,
    readonly model: string,
    baseURL?: string
  ) {
    this.client = new Anthropic({ apiKey, ...(baseURL !== undefined ? { baseURL: anthropicBaseURL(baseURL) } : {}) })
    this.capKey = `${baseURL ?? ''}\n${apiKey.slice(-8)}\n${model}`
  }

  /**
   * The loop asks for 32K output tokens. Current models take far more, but an
   * older one picked from the catalogue would reject the request outright, so
   * the ask is lowered to what the model says it allows. Not knowing is not a
   * reason to fail: the request then goes out as asked.
   */
  private outputCap(): Promise<number | null> {
    let cap = outputCaps.get(this.capKey)
    if (cap === undefined) {
      cap = this.client.models
        .retrieve(this.model)
        .then((info) => info.max_tokens ?? null)
        .catch(() => null)
      outputCaps.set(this.capKey, cap)
    }
    return cap
  }

  async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
    const cap = await this.outputCap()
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: cap !== null ? Math.min(params.maxTokens, cap) : params.maxTokens,
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
