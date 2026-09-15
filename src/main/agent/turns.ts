import { CONTINUE_PROMPT } from '@shared/ipc'
import type { Message } from '../providers/types'

/** Opens the memory a compaction leaves in place of the turns it folded. */
export const MEMORY_HEADER = '[Automatic context compaction — durable memory from earlier turns]'

/**
 * A prompt somebody typed: not tool results, not only follow-ups, and not the
 * paragraph a resume sends. Editing and retrying count these.
 */
export function isTypedPrompt(message: Message): boolean {
  if (message.role !== 'user' || message.content.some((block) => block.type === 'tool_result')) return false
  return message.content.some((block) =>
    block.type === 'text' && block.attachment === undefined && block.followUp === undefined &&
    block.internal !== true &&
    block.text !== CONTINUE_PROMPT && !block.text.startsWith(MEMORY_HEADER))
}

/**
 * How many runs answered in these messages: a prompt the model replied to.
 * A run that never got a response left no summary, so it counts for none.
 */
export function answeredRuns(messages: Message[]): number {
  let runs = 0
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message?.role !== 'user' || message.content.some((block) => block.type === 'tool_result')) continue
    if (messages[i + 1]?.role === 'assistant') runs += 1
  }
  return runs
}
