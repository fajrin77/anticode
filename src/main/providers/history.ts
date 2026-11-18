import type { Message } from './types'

/**
 * Providers validate `tool_use` names in HISTORY, not just in the tool list
 * (Anthropic caps at 200 chars, OpenAI at 64). A model that hallucinates a
 * call — e.g. pasting a whole shell command as the name — poisons every later
 * request that replays it, failing the entire session with a 400 that has
 * nothing to do with the current turn. Dropping the bad call and its result
 * keeps one wild turn from bricking the session; the tool definitions
 * themselves are already valid, so only history needs this.
 *
 * Calls and results that lost their partner (an old persisted session, a
 * crash mid-tool) are dropped too: every provider rejects an unpaired id.
 * The last message is left alone, since its calls may still be running.
 */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/

export function dropInvalidToolCalls(messages: Message[], maxNameLength: number): Message[] {
  const bad = new Set<string>()
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        calls.add(block.id)
        if (block.name.length > maxNameLength || !NAME_PATTERN.test(block.name)) bad.add(block.id)
      } else if (block.type === 'tool_result') results.add(block.toolUseId)
    }
  }
  messages.slice(0, -1).forEach((message) => {
    for (const block of message.content) {
      if (block.type === 'tool_use' && !results.has(block.id)) bad.add(block.id)
    }
  })
  for (const id of results) if (!calls.has(id)) bad.add(id)
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

/**
 * History written by one provider is replayed to another after a model switch
 * or a mid-run hand-over. Anthropic and the Responses API only accept ids
 * matching [A-Za-z0-9_-]; OpenAI-compatible routes (Kimi `functions.read:0`)
 * and Gemini produce others. Rewriting a call and its result the same way
 * keeps them paired.
 */
export function normalizeToolIds(messages: Message[]): Message[] {
  const mapped = new Map<string, string>()
  const used = new Set<string>()
  const idFor = (id: string): string => {
    const known = mapped.get(id)
    if (known !== undefined) return known
    let next = NAME_PATTERN.test(id) ? id : id.replace(/[^A-Za-z0-9_-]/g, '_') || 'call'
    for (let n = 1; used.has(next) && next !== id; n++) next = `${next}_${n}`
    mapped.set(id, next)
    used.add(next)
    return next
  }
  if (messages.every((m) => m.content.every((b) => b.type !== 'tool_use' || NAME_PATTERN.test(b.id)))) return messages
  return messages.map((message) => ({
    ...message,
    content: message.content.map((block) =>
      block.type === 'tool_use'
        ? { ...block, id: idFor(block.id) }
        : block.type === 'tool_result'
          ? { ...block, toolUseId: idFor(block.toolUseId) }
          : block
    )
  }))
}
