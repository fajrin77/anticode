import { expect, it } from 'vitest'
import type { Message } from '../providers/types'
import { withoutHistoricalImages } from './payloadReplay'

it('elides only historical images without mutating the transcript or tool identities', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'earlier' }, { type: 'image', mediaType: 'image/png', data: 'a'.repeat(1000) }] },
    { role: 'user', content: [{ type: 'text', text: 'latest' }, { type: 'image', mediaType: 'image/png', data: 'latest-image' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call1', name: 'read_file', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call1', content: 'done', isError: false }] }
  ]
  const original = structuredClone(messages)
  const replay = withoutHistoricalImages(messages)
  expect(replay[0]?.content[1]?.type).toBe('text')
  expect(replay.slice(1)).toEqual(messages.slice(1))
  expect(messages).toEqual(original)
  expect(withoutHistoricalImages(replay)).toEqual(replay)
})

it('never removes images from the only/latest request', () => {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'inspect' }, { type: 'image', mediaType: 'image/png', data: 'new' }] }]
  expect(withoutHistoricalImages(messages)).toEqual(messages)
})
