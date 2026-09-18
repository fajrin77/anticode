import type { Message } from './types'

/**
 * Providers validate `tool_use` names in HISTORY, not just in the tool list
 * (Anthropic caps at 200 chars, OpenAI at 64). A model that hallucinates a
 * call — e.g. pasting a whole shell command as the name — poisons every later
 * request that replays it, failing the entire session with a 400 that has
 * nothing to do with the current turn. Dropping the bad call and its result
 * keeps one wild turn from bricking the session; the tool definitions
 * themselves are already valid, so only history needs this.
 */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/

export function dropInvalidToolCalls(messages: Message[], maxNameLength: number): Message[] {
  const bad = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (
        block.type === 'tool_use' &&
        (block.name.length > maxNameLength || !NAME_PATTERN.test(block.name))
      ) {
        bad.add(block.id)
      }
    }
  }
  if (bad.size === 0) return messages
  return messages.flatMap((message) => {
    const content = message.content.filter((block) => {
      if (block.type === 'tool_use') return !bad.has(block.id)
      if (block.type === 'tool_result') return !bad.has(block.toolUseId)
      return true
    })
    return content.length === 0 ? [] : [{ ...message, content }]
  })
}
