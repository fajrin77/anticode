import type { Message } from '../providers/types'
import { isTypedPrompt } from './turns'

/** Only historical images may be elided. New attachments need real vision. */
export function withoutHistoricalImages(messages: Message[]): Message[] {
  const latest = messages.findLastIndex(isTypedPrompt)
  return messages.map((message, index) => index >= latest ? message : {
    ...message,
    content: message.content.map(block => block.type === 'image'
      ? { type: 'text' as const, text: '[Historical image omitted from this request to respect the provider payload limit. Original retained in transcript. Use existing textual evidence only; do not invent image details.]' }
      : block)
  })
}
