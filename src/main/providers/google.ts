import { FIRST_DATA_TIMEOUT_MS, STREAM_INACTIVITY_MS } from './openai'
import { ProviderRequestError } from './requestError'
import { randomUUID } from 'node:crypto'
import { GoogleGenAI } from '@google/genai'
import type { Content, FunctionDeclaration, Part, Schema, ThinkingLevel } from '@google/genai'
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
import { requestEffort } from '../effort'
import { thinkingConfig } from './geminiThinking'

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

export function toDeclarations(tools: ToolDefinition[]): FunctionDeclaration[] {
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

/** Gemini 3 signs its function calls; the signature must come back with the call. */
const SIGNATURE_PROVIDER = 'google-signature'

export function toContents(messages: Message[]): Content[] {
  const clean = dropInvalidToolCalls(messages, 64)
  const signatures = new Map<string, string>()
  for (const message of clean) for (const block of message.content) {
    const raw = block.type === 'opaque' && block.provider === SIGNATURE_PROVIDER ? block.raw as { id?: unknown; signature?: unknown } : undefined
    if (typeof raw?.id === 'string' && typeof raw.signature === 'string') signatures.set(raw.id, raw.signature)
  }
  const names = mapCallNames(clean)

  const out: Content[] = []
  for (const message of clean) {
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
          },
          ...(signatures.has(block.id) ? { thoughtSignature: signatures.get(block.id)! } : {})
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

    if (parts.length === 0) continue
    const role = message.role === 'assistant' ? 'model' : 'user'
    const previous = out[out.length - 1]
    if (previous?.role === role && previous.parts) previous.parts.push(...parts)
    else out.push({ role, parts })
  }
  return out
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
    readonly model: string,
    httpOptions?: { baseUrl: string; headers: Record<string, string> }
  ) {
    this.client = new GoogleGenAI({ apiKey, ...(httpOptions ? { httpOptions } : {}) })
  }

  async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
    params.signal.throwIfAborted()
    // Gemini rejects an empty functionDeclarations array, so chat mode, which
    // is offered no tools at all, must not send the tools key.
    const tools =
      params.tools.length > 0 ? [{ functionDeclarations: toDeclarations(params.tools) }] : undefined

    const watchdog = new AbortController()
    const onOuterAbort = (): void => watchdog.abort()
    params.signal.addEventListener('abort', onOuterAbort, { once: true })
    let received = false
    let inactivity: ReturnType<typeof setTimeout> | null = null
    const bump = (): void => {
      if (inactivity !== null) clearTimeout(inactivity)
      inactivity = setTimeout(() => watchdog.abort(), received ? STREAM_INACTIVITY_MS : FIRST_DATA_TIMEOUT_MS)
    }
    const stalled = (): Error => received
      ? new ProviderRequestError('Google stream stalled mid-turn. The run stopped so nothing is duplicated', 503)
      : Object.assign(new Error('Google stream stalled before any data arrived'), { status: 503 })
    bump()

    let text = ''
    let finishReason: string | undefined
    const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }
    const calls: ContentBlock[] = []

    try {
      const stream = await this.client.models.generateContentStream({
        model: this.model,
        contents: toContents(params.messages),
        config: {
          systemInstruction: params.system,
          ...(tools !== undefined ? { tools } : {}),
          maxOutputTokens: params.maxTokens,
          ...thinkingConfig(requestEffort('gemini', this.model)) as { thinkingConfig?: { thinkingLevel: ThinkingLevel } },
          abortSignal: watchdog.signal
        }
      })

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
            received = true
            text += part.text
            yield { type: 'text_delta', text: part.text }
          } else if ((part as { thought?: unknown }).thought) {
            received = true
          }
          if (part.functionCall) {
            received = true
            const id = part.functionCall.id ?? syntheticId()
            if (typeof part.thoughtSignature === 'string') calls.push({ type: 'opaque', provider: SIGNATURE_PROVIDER, raw: { id, signature: part.thoughtSignature } })
            calls.push({
              type: 'tool_use',
              id,
              name: part.functionCall.name ?? 'unknown',
              input: part.functionCall.args ?? {}
            })
          }
        }
        bump()
      }
    } catch (error) {
      if (watchdog.signal.aborted && !params.signal.aborted) throw stalled()
      throw error
    } finally {
      if (inactivity !== null) clearTimeout(inactivity)
      params.signal.removeEventListener('abort', onOuterAbort)
    }

    if (watchdog.signal.aborted && !params.signal.aborted) throw stalled()
    if (!finishReason) throw new ProviderRequestError('Google stream ended before completion; no partial tool calls were executed.', 503)
    const content: ContentBlock[] = text !== '' ? [{ type: 'text', text }, ...calls] : calls
    const response: LLMResponse = {
      content,
      stopReason: toStopReason(finishReason, calls.length > 0),
      usage
    }
    yield { type: 'response', response }
  }
}
