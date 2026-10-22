import { ProviderRequestError } from './requestError'
import OpenAI from 'openai'
import { toInput, toTools } from './codex'
import type { ChatParams, ContentBlock, LLMProvider, ProviderEvent } from './types'

/** Standard Responses API; account-specific Codex headers and endpoint are not used. */
export class ResponsesProvider implements LLMProvider {
  readonly name = 'responses'
  private readonly client: OpenAI
  constructor(key: string, readonly model: string, baseURL: string, headers: Record<string, string>) {
    this.client = new OpenAI({ apiKey: key, baseURL, defaultHeaders: headers, maxRetries: 0 })
  }
  async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
    const stream = await this.client.responses.create({
      model: this.model, instructions: params.system,
      input: toInput(params.messages) as OpenAI.Responses.ResponseInput,
      tools: toTools(params.tools) as OpenAI.Responses.Tool[],
      max_output_tokens: params.maxTokens, store: false, stream: true
    }, { signal: params.signal })
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') yield { type: 'text_delta', text: event.delta }
      if (event.type === 'response.failed' || event.type === 'response.incomplete') throw new Error('The model response did not complete. No partial tool calls were executed.')
      if (event.type === 'error') throw new Error(event.message)
      if (event.type !== 'response.completed') continue
      const content: ContentBlock[] = []
      for (const item of event.response.output) {
        if (item.type === 'function_call') {
          let input: unknown
          try { input = JSON.parse(item.arguments || '{}') } catch { throw new Error('The model returned invalid tool arguments; no tool call was executed.') }
          content.push({ type: 'tool_use', id: item.call_id, name: item.name, input })
        } else if (item.type === 'message') {
          for (const part of item.content) {
            if (part.type === 'output_text') content.push({ type: 'text', text: part.text })
          }
        }
      }
      const usage = event.response.usage
      yield { type: 'response', response: {
        content, stopReason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: { inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0, cachedTokens: usage?.input_tokens_details?.cached_tokens ?? 0 }
      } }
      return
    }
    throw new ProviderRequestError('The model stream ended without a completed response.', 503)
  }
}
