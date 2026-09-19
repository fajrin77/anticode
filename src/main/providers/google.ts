import { randomUUID } from 'node:crypto'
import { GoogleGenAI } from '@google/genai'
import type { Content, FunctionDeclaration, Part, Schema } from '@google/genai'
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
import { dropInvalidToolCalls } from './history'

/** Ids we invent for calls Gemini returned without one; never sent back. */
const SYNTHETIC_PREFIX = 'gen-'

/**
 * Gemini omits tool-call ids far more often than it includes them, so ids are
 * synthesised per call instead of per response, two turns that both get
 * unnamed calls must not collide when names are looked up from history later.
 */
function syntheticId(): string {
  return `${SYNTHETIC_PREFIX}${randomUUID()}`
}

const SCHEMA_KEYS = [
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minimum',
  'maximum'
] as const

/** Gemini rejects JSON Schema keywords it does not know, so allowlist instead of filter. */
function toGeminiSchema(schema: unknown): Schema {
  if (schema === null || typeof schema !== 'object') return {}
  const source = schema as Record<string, unknown>
  const out: Record<string, unknown> = {}

  for (const key of SCHEMA_KEYS) {
    if (!(key in source)) continue
    if (key === 'properties') {
      const properties = source[key] as Record<string, unknown>
      out[key] = Object.fromEntries(
        Object.entries(properties).map(([name, value]) => [name, toGeminiSchema(value)])
      )
    } else if (key === 'items') {
      out[key] = toGeminiSchema(source[key])
    } else {
      out[key] = source[key]
    }
  }

  return out as Schema
}

function toDeclarations(tools: ToolDefinition[]): FunctionDeclaration[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toGeminiSchema(tool.inputSchema)
  }))
}

/** functionResponse needs the function name, which only the original call carries. */
function mapCallNames(messages: Message[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') names.set(block.id, block.name)
    }
  }
  return names
}

function toContents(messages: Message[]): Content[] {
  const clean = dropInvalidToolCalls(messages, 64)
  const names = mapCallNames(clean)

  return clean.flatMap((message): Content[] => {
    const parts: Part[] = []

    for (const block of message.content) {
      if (block.type === 'text' && block.text !== '') {
        parts.push({ text: block.text })
      } else if (block.type === 'image') {
        parts.push({ inlineData: { mimeType: block.mediaType, data: block.data } })
      } else if (block.type === 'tool_use') {
        parts.push({
          functionCall: {
            ...(block.id.startsWith(SYNTHETIC_PREFIX) ? {} : { id: block.id }),
            name: block.name,
            args: (block.input ?? {}) as Record<string, unknown>
          }
        })
      } else if (block.type === 'tool_result') {
        parts.push({
          functionResponse: {
            ...(block.toolUseId.startsWith(SYNTHETIC_PREFIX) ? {} : { id: block.toolUseId }),
            name: names.get(block.toolUseId) ?? 'unknown',
            response: block.isError
              ? { error: block.content }
              : { output: block.content }
          }
        })
      }
    }

    if (parts.length === 0) return []
    return [{ role: message.role === 'assistant' ? 'model' : 'user', parts }]
  })
}

function toStopReason(reason: string | undefined, hasCalls: boolean): StopReason {
  if (hasCalls) return 'tool_use'
  if (reason === 'MAX_TOKENS') return 'max_tokens'
  if (reason !== undefined && reason !== 'STOP') return 'refusal'
  return 'end_turn'
}

export class GoogleProvider implements LLMProvider {
  readonly name = 'google'
  private readonly client: GoogleGenAI

  constructor(
    apiKey: string,
    readonly model: string
  ) {
    this.client = new GoogleGenAI({ apiKey })
  }

  async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
    // Gemini rejects an empty functionDeclarations array, so chat mode, which
    // is offered no tools at all, must not send the tools key.
    const tools =
      params.tools.length > 0 ? [{ functionDeclarations: toDeclarations(params.tools) }] : undefined

    const stream = await this.client.models.generateContentStream({
      model: this.model,
      contents: toContents(params.messages),
      config: {
        systemInstruction: params.system,
        ...(tools !== undefined ? { tools } : {}),
        maxOutputTokens: params.maxTokens,
        abortSignal: params.signal
      }
    })

    let text = ''
    let finishReason: string | undefined
    const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }
    const calls: ContentBlock[] = []

    for await (const chunk of stream) {
      if (chunk.usageMetadata) {
        usage.inputTokens = chunk.usageMetadata.promptTokenCount ?? usage.inputTokens
        usage.outputTokens = chunk.usageMetadata.candidatesTokenCount ?? usage.outputTokens
        usage.cachedTokens = chunk.usageMetadata.cachedContentTokenCount ?? usage.cachedTokens
      }

      const candidate = chunk.candidates?.[0]
      if (candidate?.finishReason) finishReason = candidate.finishReason

      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part.text === 'string' && part.text !== '') {
          text += part.text
          yield { type: 'text_delta', text: part.text }
        }
        if (part.functionCall) {
          calls.push({
            type: 'tool_use',
            id: part.functionCall.id ?? syntheticId(),
            name: part.functionCall.name ?? 'unknown',
            input: part.functionCall.args ?? {}
          })
        }
      }
    }

    const content: ContentBlock[] = text !== '' ? [{ type: 'text', text }, ...calls] : calls
    const response: LLMResponse = {
      content,
      stopReason: toStopReason(finishReason, calls.length > 0),
      usage
    }
    yield { type: 'response', response }
  }
}
