import { describe, expect, it } from 'vitest'
import { dropInvalidToolCalls, normalizeToolIds } from './history'
import type { Message } from './types'

function msg(content: Message['content']): Message {
  return { role: 'assistant', content }
}

it('keeps a clean history untouched', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'halo' }] },
    msg([
      { type: 'tool_use', id: 'c1', name: 'read_file', input: {} },
      { type: 'tool_result', toolUseId: 'c1', content: 'isi', isError: false }
    ])
  ]
  expect(dropInvalidToolCalls(messages, 64)).toBe(messages)
})

it('drops a hallucinated call and its result, keeping the rest', () => {
  const badName = 'git_diff_base_helper() { :; }; git log -1 --format="%h %ad" --date=short -S "follow-up: typing turns pause into send" -- scripts/verify-ui.mjs; git log -1 --format="%h %ad" --date=short -S "another pattern here" -- src/main/agent/loop.ts'
  expect(badName.length).toBeGreaterThan(64)
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'cari' }] },
    msg([
      { type: 'text', text: 'cek dulu' },
      { type: 'tool_use', id: 'bad', name: badName, input: {} },
      { type: 'tool_use', id: 'good', name: 'read_file', input: {} }
    ]),
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'bad', content: 'out', isError: false },
        { type: 'tool_result', toolUseId: 'good', content: 'isi', isError: false }
      ]
    },
    msg([{ type: 'text', text: 'selesai' }])
  ]
  const clean = dropInvalidToolCalls(messages, 200)
  const dumped = JSON.stringify(clean)
  expect(dumped).not.toContain('grep -n')
  expect(dumped).toContain('cek dulu')
  expect(dumped).toContain('read_file')
  expect(dumped).toContain('selesai')
})

it('rejects names with illegal characters even when short', () => {
  const messages: Message[] = [
    msg([{ type: 'tool_use', id: 'c1', name: 'weird name!', input: {} }])
  ]
  expect(dropInvalidToolCalls(messages, 200)).toEqual([])
})

describe('cross-provider replay', () => {
  it('rewrites foreign tool ids for strict providers and keeps call and result paired', () => {
    const out = normalizeToolIds([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'functions.read:0', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'functions.read:0', content: 'ok', isError: false }] }
    ])
    const call = out[0]!.content[0] as { id: string }
    const result = out[1]!.content[0] as { toolUseId: string }
    expect(call.id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(result.toolUseId).toBe(call.id)
  })

  it('drops calls and results that lost their partner, except in the last message', () => {
    const out = dropInvalidToolCalls([
      { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 'lost', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'ghost', content: 'x', isError: false }, { type: 'text', text: 'b' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'live', name: 'read', input: {} }] }
    ], 64)
    expect(out.map((m) => m.content.map((b) => b.type))).toEqual([['text'], ['text'], ['tool_use']])
  })
})
