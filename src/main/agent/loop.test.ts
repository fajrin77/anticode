import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/ipc'
import { CONTINUE_PROMPT } from '@shared/ipc'
import { AgentSession, titleOf } from './loop'
import { InputRequestLimitError } from '../providers/requestLimits'
import { allowAll } from '../approval/types'
import { editFileTool } from '../tools/editFile'
import type {
  ChatParams,
  ContentBlock,
  LLMProvider,
  LLMResponse,
  Message,
  ProviderEvent
} from '../providers/types'

function turn(content: ContentBlock[], stopReason: LLMResponse['stopReason']): LLMResponse {
  return { content, stopReason, usage: { inputTokens: 10, outputTokens: 5 } }
}

class FakeProvider implements LLMProvider {
  readonly name = 'fake'
  readonly model = 'fake-model'
  /** History as it was sent on each turn, so tests can assert what the loop built. */
  readonly sent: Message[][] = []
  /** What each compaction request was shown; they do not use up a turn. */
  readonly compactions: string[] = []
  /** The memory a compaction request answers with; null makes it fail. */
  memory: string | null = 'MODEL MEMORY: goal, decisions, files, next steps'

  constructor(
    private readonly turns: LLMResponse[],
    private readonly onTurn?: (index: number) => void
  ) {}

  async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
    if (params.system.startsWith('You compact')) {
      const shown = params.messages[0]?.content[0]
      this.compactions.push(shown?.type === 'text' ? shown.text : '')
      if (this.memory === null) throw new Error('summary failed')
      yield { type: 'response', response: turn([{ type: 'text', text: this.memory }], 'end_turn') }
      return
    }
    const index = this.sent.length
    this.sent.push(structuredClone(params.messages))
    this.onTurn?.(index)

    const response = this.turns[index]
    if (!response) throw new Error(`FakeProvider kehabisan giliran di indeks ${index}`)

    for (const block of response.content) {
      if (block.type === 'text') yield { type: 'text_delta', text: block.text }
    }
    yield { type: 'response', response }
  }
}

let root: string
let events: AgentEvent[]

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'anticode-loop-'))
  events = []
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function run(provider: LLMProvider, controller = new AbortController()): Promise<void> {
  await new AgentSession(provider, allowAll, 'code', root).run({
    runId: 'run-1',
    prompt: 'kerjakan sesuatu',
    signal: controller.signal,
    emit: (event) => events.push(event)
  })
}

function lastContent(provider: FakeProvider, turnIndex: number): ContentBlock[] {
  return provider.sent[turnIndex]?.at(-1)?.content ?? []
}

describe('AgentSession', () => {
  it('recovers raw DSML once using native tools without leaking or executing the raw command', async () => {
    const raw = '< | DSML | invoke name="write_file">< | DSML | parameter name="path">raw.txt'
    const provider = new FakeProvider([
      turn([{ type: 'tool_use', id: 'before', name: 'write_file', input: { path: 'before.txt', content: 'confirmed' } }], 'tool_use'),
      turn([{ type: 'text', text: 'Safe progress. ' + raw }], 'end_turn'),
      turn([{ type: 'tool_use', id: 'native', name: 'write_file', input: { path: 'native.txt', content: 'native result' } }], 'tool_use'),
      turn([{ type: 'text', text: 'Finished.' }], 'end_turn')
    ])
    const session = new AgentSession(provider, allowAll, 'code', root)
    let fallbacks = 0
    session.useProvider(provider, () => { fallbacks++; return null })
    await session.run({ runId: 'dsml', prompt: 'finish', signal: new AbortController().signal, emit: event => events.push(event) })
    expect(await readFile(path.join(root, 'before.txt'), 'utf8')).toBe('confirmed')
    expect(await readFile(path.join(root, 'native.txt'), 'utf8')).toBe('native result')
    await expect(readFile(path.join(root, 'raw.txt'))).rejects.toThrow()
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'complete' })
    expect(events.filter(event => event.type === 'tool_end')).toHaveLength(2)
    expect(events.filter(event => event.type === 'notice')).toHaveLength(1)
    expect(fallbacks).toBe(0)
    const visible = JSON.stringify(events)
    expect(visible).toContain('Safe progress.')
    expect(visible).not.toContain('< | DSML')
    expect(visible).not.toContain('raw.txt')
    expect(JSON.stringify(session.snapshot())).not.toContain('raw.txt')
    expect(provider.sent).toHaveLength(4)
    expect(lastContent(provider, 2)).toEqual([expect.objectContaining({ type: 'text', internal: true, text: expect.stringContaining('native structured tool-call') })])
  })

  it.each([true, false])('stops repeated raw DSML with a clear error and no fallback (deltas: %s)', async deltas => {
    let requests = 0
    const provider: LLMProvider = { name: 'fixture', model: 'deepseek-fixture', async *chat() {
      requests++
      const raw = '<｜DSML｜invoke name="run_command">do-not-execute'
      if (deltas) for (const char of raw) yield { type: 'text_delta', text: char }
      yield { type: 'response', response: turn([{ type: 'text', text: raw }], 'end_turn') }
    } }
    const session = new AgentSession(provider, allowAll, 'code', root)
    let fallbacks = 0
    session.useProvider(provider, () => { fallbacks++; return null })
    await session.run({ runId: 'dsml', prompt: 'finish', signal: new AbortController().signal, emit: event => events.push(event) })
    expect(requests).toBe(2)
    expect(fallbacks).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('format tool yang tidak valid') })
    expect(events.filter(event => event.type === 'tool_end')).toEqual([])
    expect(events.filter(event => event.type === 'text_delta')).toEqual([])
    expect(JSON.stringify(session.snapshot())).not.toContain('do-not-execute')
  })

  it('does not execute native calls mixed with malformed DSML in a response-only turn', async () => {
    let requests = 0
    const provider: LLMProvider = { name: 'fixture', model: 'deepseek-fixture', async *chat() {
      requests++
      yield { type: 'response', response: turn([
        { type: 'text', text: '<|DSML|invoke name="write_file">raw' },
        { type: 'tool_use', id: 'mixed', name: 'write_file', input: { path: 'mixed.txt', content: 'must not run' } }
      ], 'tool_use') }
    } }
    await run(provider)
    expect(requests).toBe(2)
    await expect(readFile(path.join(root, 'mixed.txt'))).rejects.toThrow()
    expect(events.filter(event => event.type === 'tool_end')).toEqual([])
  })

  it.each(['deepseek-v3-flash:free', 'deepseek/deepseek-v3', 'laguna-s-2.1'])('continues text after an old image with %s and restores original images for vision', async (model) => {
    const history: Message[] = [
      { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'fixture' }, { type: 'text', text: 'jelaskan gambar' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Catatan teks sebelumnya.' }] }
    ]
    const sent: Message[][] = []
    const provider = (model: string): LLMProvider => ({ name: 'fixture', model, async *chat(params) {
      sent.push(structuredClone(params.messages))
      yield { type: 'response', response: turn([{ type: 'text', text: 'OK' }], 'end_turn') }
    } })
    const session = new AgentSession(provider(model), allowAll, 'chat', undefined, history)
    const send = (prompt: string) => session.run({ runId: 'image-replay', prompt, signal: new AbortController().signal, emit: (event) => events.push(event) })
    await send('lanjutkan pekerjaan teks')
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'complete' })
    expect(sent[0]?.flatMap((message) => message.content).some((block) => block.type === 'image')).toBe(false)
    expect(events.some((event) => event.type === 'notice' && event.text.includes('Gambar'))).toBe(true)
    session.useProvider(provider('vision-model'))
    await send('periksa gambar sebelumnya')
    expect(sent[1]?.flatMap((message) => message.content).some((block) => block.type === 'image')).toBe(true)
  })

  it('refuses a new image on a text model before calling the provider', async () => {
    let called = false
    const provider: LLMProvider = { name: 'fixture', model: 'deepseek-v3:free', async *chat() { called = true; yield { type: 'response', response: turn([], 'end_turn') } } }
    const session = new AgentSession(provider, allowAll, 'chat')
    await session.run({ runId: 'new-image', prompt: 'baca gambar ini', attachments: [{ type: 'image', mediaType: 'image/png', data: 'fixture' }], signal: new AbortController().signal, emit: (event) => events.push(event) })
    expect(called).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('Gambar baru') })
  })

  it('can resume with a text model after a previous vision turn', async () => {
    const sent: Message[][] = []
    const provider: LLMProvider = { name: 'fixture', model: 'deepseek-v3:free', async *chat(params) {
      sent.push(structuredClone(params.messages))
      yield { type: 'response', response: turn([{ type: 'text', text: 'lanjut' }], 'end_turn') }
    } }
    const session = new AgentSession(provider, allowAll, 'chat', null, [
      { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'fixture' }, { type: 'text', text: 'kerjakan' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'sudah diperiksa' }] }
    ])
    await session.run({ runId: 'resume', prompt: CONTINUE_PROMPT, signal: new AbortController().signal, emit: (event) => events.push(event) })
    expect(sent).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'complete' })
  })

  it.each(['deepseek-ai/deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash:free'])('passes new images to %s without assuming its route is text-only', async model => {
    const sent: Message[][] = []
    const provider: LLMProvider = { name: 'fixture', model, async *chat(params) {
      sent.push(structuredClone(params.messages))
      yield { type: 'response', response: turn([{ type: 'text', text: 'fixture response, not a vision capability probe' }], 'end_turn') }
    } }
    const session = new AgentSession(provider, allowAll, 'chat')
    await session.run({ runId: 'v41-image', prompt: 'baca gambar', attachments: [{ type: 'image', mediaType: 'image/png', data: 'fixture' }], signal: new AbortController().signal, emit: event => events.push(event) })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.flatMap(message => message.content)).toContainEqual(expect.objectContaining({ type: 'image', data: 'fixture' }))
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'complete' })
  })

  it('preserves a quota-interrupted report and makes it resumable without replaying it', async () => {
    let calls = 0
    const provider: LLMProvider = { name: 'fixture', model: 'fixture-model', async *chat() {
      calls++
      yield { type: 'text_delta', text: 'Pekerjaan yang sudah selesai: ' }
      throw Object.assign(new Error('usage limit reached'), { status: 429 })
    } }
    const session = new AgentSession(provider, allowAll, 'chat')
    let fallbackCalls = 0
    session.useProvider(provider, () => { fallbackCalls++; return null })
    await session.run({ runId: 'quota-partial', prompt: 'kerjakan', signal: new AbortController().signal, emit: (event) => events.push(event) })
    expect(calls).toBe(1)
    expect(fallbackCalls).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'error', retryable: true, keptReplyModel: 'fixture-model' })
    expect(session.snapshot().messages.some((message) => message.content.some((block) => block.type === 'text' && block.text.includes('Pekerjaan yang sudah selesai')))).toBe(true)
  })

  it('rejects batch models before calling the provider', async () => {
    let called = false
    await run({ name: 'fixture', model: 'moonshotai/kimi-k3:batch', async *chat() { called = true; yield { type: 'response', response: turn([], 'end_turn') } } })
    expect(called).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('batch') })
  })

  it('streams text and ends the turn', async () => {
    await run(new FakeProvider([turn([{ type: 'text', text: 'selesai' }], 'end_turn')]))

    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text)).toEqual(['selesai'])
    expect(events.at(-1)).toEqual({ type: 'end', runId: 'run-1', reason: 'complete' })
  })

  it('feeds tool results back as a single user message', async () => {
    await writeFile(path.join(root, 'a.txt'), 'isi')
    const provider = new FakeProvider([
      turn(
        [
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.txt' } },
          { type: 'tool_use', id: 't2', name: 'list_directory', input: { path: '.' } }
        ],
        'tool_use'
      ),
      turn([{ type: 'text', text: 'beres' }], 'end_turn')
    ])

    await run(provider)

    const results = lastContent(provider, 1)
    expect(results).toHaveLength(2)
    expect(results.map((block) => (block.type === 'tool_result' ? block.toolUseId : null))).toEqual([
      't1',
      't2'
    ])
    expect(results.every((block) => block.type === 'tool_result' && !block.isError)).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'end', runId: 'run-1', reason: 'complete' })
  })

  it('finishes every item in a three-item plan without waiting for another user prompt', async () => {
    const open = [
      { content: 'Prompt one', status: 'completed' },
      { content: 'Prompt two', status: 'in_progress' },
      { content: 'Prompt three', status: 'pending' }
    ]
    const complete = open.map((item) => ({ ...item, status: 'completed' as const }))
    const provider = new FakeProvider([
      turn([{ type: 'tool_use', id: 'plan-open', name: 'todo_write', input: { items: open } }], 'tool_use'),
      turn([{ type: 'text', text: 'Bagian pertama selesai.' }], 'end_turn'),
      turn([{ type: 'tool_use', id: 'plan-done', name: 'todo_write', input: { items: complete } }], 'tool_use'),
      turn([{ type: 'text', text: 'Semua selesai.' }], 'end_turn')
    ])
    const session = new AgentSession(provider, allowAll, 'code', root)

    await session.run({
      runId: 'planned', prompt: 'kerjakan tiga permintaan', signal: new AbortController().signal,
      emit: (event) => events.push(event)
    })

    expect(provider.sent).toHaveLength(4)
    expect(lastContent(provider, 2)).toEqual([
      expect.objectContaining({ type: 'text', internal: true, text: expect.stringContaining('do not ask the user to type continue') })
    ])
    expect(session.snapshot().messages.flatMap((message) => message.content).some(
      (block) => block.type === 'text' && block.internal === true
    )).toBe(true)
    expect(events.filter((event) => event.type === 'end')).toEqual([
      { type: 'end', runId: 'planned', reason: 'complete' }
    ])
  })

  it('does not turn a two-item checklist into an auto-continuing plan', async () => {
    const provider = new FakeProvider([
      turn([{ type: 'tool_use', id: 'short-plan', name: 'todo_write', input: { items: [
        { content: 'One', status: 'in_progress' },
        { content: 'Two', status: 'pending' }
      ] } }], 'tool_use'),
      turn([{ type: 'text', text: 'done' }], 'end_turn')
    ])

    await run(provider)

    expect(provider.sent).toHaveLength(2)
    expect(events.at(-1)).toEqual({ type: 'end', runId: 'run-1', reason: 'complete' })
  })

  it('offers one recovery before stopping repeated unchanged checks', async () => {
    await writeFile(path.join(root, 'same.txt'), 'unchanged')
    const provider = new FakeProvider([1, 2, 3, 4].map((index) => turn([
      { type: 'tool_use', id: `read-${index}`, name: 'read_file', input: { path: 'same.txt' } }
    ], 'tool_use')))

    await run(provider)

    expect(provider.sent).toHaveLength(4)
    expect(events.some(event => event.type === 'notice')).toBe(true)
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('repeated tool loop')
    })
  })

  it('stops alternating unchanged checks even when checklist updates interrupt them', async () => {
    await writeFile(path.join(root, 'same.txt'), 'unchanged')
    const provider = new FakeProvider([1, 2, 3].flatMap((index) => [
      turn([{ type: 'tool_use', id: `read-${index}`, name: 'read_file', input: { path: 'same.txt' } }], 'tool_use'),
      turn([{ type: 'tool_use', id: `list-${index}`, name: 'list_directory', input: { path: '.' } }], 'tool_use')
    ]))
    const session = new AgentSession(provider, allowAll, 'code', root)
    await session.run({ runId: 'cycle', prompt: 'inspect the file', signal: new AbortController().signal, emit: (event) => events.push(event) })
    expect(provider.sent).toHaveLength(6)
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('repeated tool loop') })
    // A reload and Continue must retain the stop instead of paying for the same loop again.
    const resumedProvider = new FakeProvider([turn([{type:'text',text:'Used the existing evidence and finished with a different action.'}],'end_turn')])
    const resumed = new AgentSession(resumedProvider, allowAll, 'code', root, session.snapshot().messages)
    await resumed.run({ runId: 'resume', prompt: CONTINUE_PROMPT, signal: new AbortController().signal, emit: (event) => events.push(event) })
    expect(resumedProvider.sent).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({type:'end',reason:'complete'})
    resumed.useProvider(new FakeProvider([turn([{ type: 'text', text: 'new evidence handled' }], 'end_turn')]))
    await resumed.run({ runId: 'new-info', prompt: 'The permission was changed; inspect a new target.', signal: new AbortController().signal, emit: (event) => events.push(event) })
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'complete' })
  })

  it('stops checklist continuations that produce no concrete work', async () => {
    const provider = new FakeProvider([
      turn([{ type: 'tool_use', id: 'plan', name: 'todo_write', input: { items: [
        { content: 'One', status: 'in_progress' }, { content: 'Two', status: 'pending' }, { content: 'Three', status: 'pending' }
      ] } }], 'tool_use'),
      ...[1, 2, 3, 4].map(() => turn([{ type: 'text' as const, text: 'I will check the same access again.' }], 'end_turn'))
    ])
    await run(provider)
    expect(provider.sent).toHaveLength(4)
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('checklist is unfinished') })
  })

  it('ends an explicitly blocked checklist without forcing further verification', async () => {
    const provider = new FakeProvider([
      turn([{ type: 'tool_use', id: 'blocked-plan', name: 'todo_write', input: { items: [
        { content: 'Read folder', status: 'completed' },
        { content: 'Edit report: missing editor permission', status: 'blocked' },
        { content: 'Verify report after edit', status: 'pending' }
      ] } }], 'tool_use'),
      turn([{ type: 'text', text: 'Editor permission is needed before editing.' }], 'end_turn')
    ])
    await run(provider)
    expect(provider.sent).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'complete' })
    expect(lastContent(provider, 1)).toEqual([expect.objectContaining({ type: 'tool_result', isError: false, content: expect.stringContaining('[!]') })])
  })

  it('does not mistake a changing polling result for an unchanged loop', async () => {
    const countTool = {
      name: 'poll_status', description: 'Read changing job status', inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      prepare: () => ({ risk: 'low' as const, preview: async () => ({ kind: 'text' as const, subject: 'status', detail: '' }), execute: async () => ({ text: String(++count), images: [] }) })
    }
    let count = 0
    const provider = new FakeProvider([
      ...[1, 2, 3, 4].map((index) => turn([{ type: 'tool_use' as const, id: `poll-${index}`, name: 'poll_status', input: {} }], 'tool_use')),
      turn([{ type: 'text', text: 'finished' }], 'end_turn')
    ])
    const session = new AgentSession(provider, allowAll, 'code', root, [], 'polling', { tools: [countTool] })
    await session.run({ runId: 'poll', prompt: 'wait for the job', signal: new AbortController().signal, emit: (event) => events.push(event) })
    expect(count).toBe(4)
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'complete' })
  })

  it('allows repeated narration while tools keep returning new evidence', async () => {
    const turns: LLMResponse[] = []
    for (let index = 0; index < 24; index++) {
      await writeFile(path.join(root, `fact-${index}.txt`), `New evidence ${index}`)
      turns.push(turn([
        { type: 'text', text: 'Reading the next fact.' },
        { type: 'tool_use', id: `fact-${index}`, name: 'read_file', input: { path: `fact-${index}.txt` } }
      ], 'tool_use'))
    }
    turns.push(turn([{ type: 'text', text: 'All facts verified.' }], 'end_turn'))
    await run(new FakeProvider(turns))
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'complete' })
    expect(events.filter(event => event.type === 'notice')).toEqual([])
  })

  it('still stops repeated narration when only tool arguments change', async () => {
    const check = {
      name: 'check_status', description: 'Check a stalled job', inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      prepare: () => ({ risk: 'low' as const, preview: async () => ({ kind: 'text' as const, subject: 'status', detail: '' }), execute: async () => ({ text: 'Still waiting', images: [] }) })
    }
    const provider = new FakeProvider(Array.from({ length: 30 }, (_, index) => turn([
      { type: 'text', text: 'Checking the same stalled job.' },
      { type: 'tool_use', id: `check-${index}`, name: 'check_status', input: { attempt: index } }
    ], 'tool_use')))
    const session = new AgentSession(provider, allowAll, 'code', root, [], 'stalled', { tools: [check] })
    await session.run({ runId: 'stalled', prompt: 'finish the job', signal: new AbortController().signal, emit: event => events.push(event) })
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('repeated narration loop') })
  })

  it('persists a provider error as a display-only transcript block', async () => {
    const provider: LLMProvider = { name: 'ollama', model: 'llama3.2', async *chat() {
      throw Object.assign(new Error('Connection error'), {retryAfter:0})
    } }
    const session = new AgentSession(provider, allowAll, 'chat')
    await session.run({
      runId: 'run-1', prompt: 'hello', signal: new AbortController().signal,
      emit: (event) => events.push(event)
    })
    const blocks = session.snapshot().messages.at(-1)?.content
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('ollama') })
    expect(blocks).toEqual([
      expect.objectContaining({ type: 'display', kind: 'error', text: expect.stringContaining('ollama') })
    ])
  })

  it('restores edited and newly-created files when the last turn is reverted', async () => {
    await writeFile(path.join(root, 'existing.txt'), 'before')
    const provider = new FakeProvider([
      turn([
        { type: 'tool_use', id: 'edit', name: 'edit_file', input: { path: 'existing.txt', old_string: 'before', new_string: 'after' } },
        { type: 'tool_use', id: 'write', name: 'write_file', input: { path: 'new.txt', content: 'created' } }
      ], 'tool_use'),
      turn([{ type: 'text', text: 'done' }], 'end_turn')
    ])
    const session = new AgentSession(provider, allowAll, 'code', root)
    await session.run({ runId: 'checkpoint', prompt: 'change files', signal: new AbortController().signal, emit: () => {} })

    expect(await readFile(path.join(root, 'existing.txt'), 'utf8')).toBe('after')
    expect(await readFile(path.join(root, 'new.txt'), 'utf8')).toBe('created')
    expect(session.revertLastTurn()).toBe('change files')
    expect(await readFile(path.join(root, 'existing.txt'), 'utf8')).toBe('before')
    await expect(readFile(path.join(root, 'new.txt'))).rejects.toThrow()
  })

  it('takes back what a shell command and an Excel tool did when the turn is reverted', async () => {
    await writeFile(path.join(root, 'notes.txt'), 'before')
    const provider = new FakeProvider([
      turn([
        { type: 'tool_use', id: 'sh', name: 'run_command', input: { command: 'echo changed > notes.txt && mkdir -p out && echo x > out/made.txt' } },
        { type: 'tool_use', id: 'xl', name: 'create_excel', input: { path: 'report.xlsx', rows: [['a']] } }
      ], 'tool_use'),
      turn([{ type: 'text', text: 'done' }], 'end_turn')
    ])
    const session = new AgentSession(provider, allowAll, 'code', root)
    await session.run({ runId: 'terminal', prompt: 'change things', signal: new AbortController().signal, emit: () => {} })

    expect((await readFile(path.join(root, 'notes.txt'), 'utf8')).trim()).toBe('changed')
    expect(await readFile(path.join(root, 'report.xlsx'))).toBeInstanceOf(Buffer)
    expect(session.revertLastTurn()).toBe('change things')
    expect(await readFile(path.join(root, 'notes.txt'), 'utf8')).toBe('before')
    await expect(readFile(path.join(root, 'out/made.txt'))).rejects.toThrow()
    await expect(readFile(path.join(root, 'report.xlsx'))).rejects.toThrow()
  })

  it('reverts files from a checkpoint written before the app was reopened', async () => {
    await writeFile(path.join(root, 'a.txt'), 'before')
    const store = await mkdtemp(path.join(tmpdir(), 'anticode-loop-cp-'))
    const provider = new FakeProvider([
      turn([{ type: 'tool_use', id: 'w', name: 'write_file', input: { path: 'a.txt', content: 'after' } }], 'tool_use'),
      turn([{ type: 'text', text: 'done' }], 'end_turn')
    ])
    const first = new AgentSession(provider, allowAll, 'code', root, [], 'scope', { checkpointDir: store })
    await first.run({ runId: 'w', prompt: 'rewrite', signal: new AbortController().signal, emit: () => {} })

    // A fresh session over the saved transcript — what a restart builds.
    const reopened = new AgentSession(new FakeProvider([]), allowAll, 'code', root, first.snapshot().messages, 'scope', { checkpointDir: store })
    expect(reopened.revertLastTurn()).toBe('rewrite')
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('before')
    await rm(store, { recursive: true, force: true })
  })

  it('returns a tool failure as an error result instead of crashing the loop', async () => {
    const provider = new FakeProvider([
      turn([{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'hilang.txt' } }], 'tool_use'),
      turn([{ type: 'text', text: 'sudah kutangani' }], 'end_turn')
    ])

    await run(provider)

    const result = lastContent(provider, 1)[0]
    expect(result?.type === 'tool_result' && result.isError).toBe(true)
    expect(events.some((e) => e.type === 'tool_end' && !e.ok)).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'end', runId: 'run-1', reason: 'complete' })
  })

  it('reports an unknown tool back to the model', async () => {
    const provider = new FakeProvider([
      turn([{ type: 'tool_use', id: 't1', name: 'tidak_ada', input: {} }], 'tool_use'),
      turn([{ type: 'text', text: 'ok' }], 'end_turn')
    ])

    await run(provider)

    const result = lastContent(provider, 1)[0]
    expect(result?.type === 'tool_result' && result.content).toContain('Unknown tool')
  })

  it('skips pending tools when cancelled and leaves replayable history', async () => {
    const controller = new AbortController()
    const provider = new FakeProvider(
      [
        turn([{ type: 'tool_use', id: 't1', name: 'run_command', input: { command: 'echo x' } }], 'tool_use'),
        turn([{ type: 'text', text: 'lanjut' }], 'end_turn')
      ],
      (index) => {
        if (index === 0) controller.abort()
      }
    )

    await run(provider, controller)

    expect(events.some((e) => e.type === 'tool_start')).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'end', runId: 'run-1', reason: 'cancelled' })
  })

  it('repairs cancelled history so the next run can replay it', async () => {
    const controller = new AbortController()
    const provider = new FakeProvider(
      [
        turn([{ type: 'tool_use', id: 't1', name: 'run_command', input: { command: 'echo x' } }], 'tool_use'),
        turn([{ type: 'text', text: 'lanjut' }], 'end_turn')
      ]
    )

    const session = new AgentSession(provider, allowAll, 'code', root)
    const emit = (event: AgentEvent): void => {
      events.push(event)
      if (event.type === 'usage' && event.runId === 'run-1') controller.abort()
    }
    const base = { emit }

    await session.run({ ...base, runId: 'run-1', prompt: 'pertama', signal: controller.signal })
    await session.run({
      ...base,
      runId: 'run-2',
      prompt: 'kedua',
      signal: new AbortController().signal
    })

    // Every tool_use the model asked for must have a matching tool_result, or
    // the provider rejects the whole history on the next request.
    const replayed = provider.sent[1] ?? []
    const toolUseIds = replayed.flatMap((message) =>
      message.content.filter((block) => block.type === 'tool_use').map((block) => block.id)
    )
    const resultIds = replayed.flatMap((message) =>
      message.content.filter((block) => block.type === 'tool_result').map((block) => block.toolUseId)
    )
    expect(toolUseIds).toEqual(['t1'])
    expect(resultIds).toEqual(['t1'])
  })

  it('does not run a tool the gate rejects, and tells the model why', async () => {
    await writeFile(path.join(root, 'a.txt'), 'asli')
    const denyAll = { authorize: async () => false }
    const provider = new FakeProvider([
      turn(
        [
          {
            type: 'tool_use',
            id: 't1',
            name: 'write_file',
            input: { path: 'a.txt', content: 'diubah' }
          }
        ],
        'tool_use'
      ),
      turn([{ type: 'text', text: 'baik' }], 'end_turn')
    ])

    await new AgentSession(provider, denyAll, 'code', root).run({
      runId: 'run-1',
      prompt: 'tulis',
      signal: new AbortController().signal,
      emit: (event) => events.push(event)
    })

    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('asli')
    const result = lastContent(provider, 1)[0]
    expect(result?.type === 'tool_result' && result.content).toContain('Rejected')
    expect(events.some((e) => e.type === 'tool_end' && e.rejected === true)).toBe(true)
  })

  it('shows a diff as the preview for an edit', async () => {
    await writeFile(path.join(root, 'a.txt'), 'satu\ndua\ntiga\n')
    const preview = await editFileTool
      .prepare({ path: 'a.txt', old_string: 'dua', new_string: 'DUA' })
      .preview({ workspaceRoot: root, signal: new AbortController().signal })

    expect(preview.kind).toBe('diff')
    expect(preview.detail).toContain('-dua')
    expect(preview.detail).toContain('+DUA')
    // Unchanged lines stay as context, so the reviewer sees where the edit lands.
    expect(preview.detail).toContain(' satu')
    expect(preview.detail).toContain('@@')
  })

  it('never shows a diff the execution would refuse', async () => {
    await writeFile(path.join(root, 'a.txt'), 'x\nx')

    const ambiguous = await editFileTool
      .prepare({ path: 'a.txt', old_string: 'x', new_string: 'y' })
      .preview({ workspaceRoot: root, signal: new AbortController().signal })
    expect(ambiguous.kind).toBe('text')
    expect(ambiguous.detail).toContain('appears 2 times')

    const absent = await editFileTool
      .prepare({ path: 'a.txt', old_string: 'tidak ada', new_string: 'y' })
      .preview({ workspaceRoot: root, signal: new AbortController().signal })
    expect(absent.kind).toBe('text')
    expect(absent.detail).toContain('not found')
  })

  it('surfaces max_tokens as its own end reason', async () => {
    await run(new FakeProvider([turn([{ type: 'text', text: 'terpotong' }], 'max_tokens')]))
    expect(events.at(-1)).toEqual({ type: 'end', runId: 'run-1', reason: 'max_tokens' })
  })

  it('drops the oldest turns once the history passes the context budget', async () => {
    await writeFile(path.join(root, 'a.txt'), 'isi')
    const provider = new FakeProvider([
      turn([{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.txt' } }], 'tool_use'),
      turn([{ type: 'text', text: 'ok' }], 'end_turn'),
      turn([{ type: 'text', text: 'next' }], 'end_turn')
    ])

    const session = new AgentSession(provider, allowAll, 'code', root)
    const emit = (event: AgentEvent): void => void events.push(event)

    await session.run({
      runId: 'run-1',
      prompt: 'x'.repeat(300_000),
      signal: new AbortController().signal,
      emit
    })
    await session.run({
      runId: 'run-2',
      prompt: 'y'.repeat(200_000),
      signal: new AbortController().signal,
      emit
    })

    // Run 1 makes two requests (tool turn, then the wrap-up); run 2's request
    // is the third.
    const replayed = provider.sent[2] ?? []
    expect(replayed).toHaveLength(2)
    expect(replayed[0]?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Automatic context compaction') })
    expect(replayed[1]?.role).toBe('user')
    // The cut must never orphan a tool_result: its tool_use goes with it.
    expect(replayed.some((m) => m.content.some((b) => b.type === 'tool_result'))).toBe(false)
  })

  it('keeps the whole history while it fits the budget', async () => {
    const provider = new FakeProvider([turn([{ type: 'text', text: 'satu' }], 'end_turn')])
    const session = new AgentSession(provider, allowAll, 'code', root)
    const emit = (event: AgentEvent): void => void events.push(event)

    await session.run({
      runId: 'run-1',
      prompt: 'halo',
      signal: new AbortController().signal,
      emit
    })
    await session.run({
      runId: 'run-2',
      prompt: 'lagi',
      signal: new AbortController().signal,
      emit
    })

    const replayed = provider.sent[1] ?? []
    expect(replayed).toHaveLength(3)
  })

  it('keeps old and recent tool evidence intact while it fits the context budget', async () => {
    for (const id of ['1', '2', '3', '4']) await writeFile(path.join(root, `a${id}.txt`), 'x'.repeat(2000))
    const toolTurn = (id: string): LLMResponse =>
      turn([{ type: 'tool_use', id: `t${id}`, name: 'read_file', input: { path: `a${id}.txt` } }], 'tool_use')
    const provider = new FakeProvider([
      toolTurn('1'),
      toolTurn('2'),
      toolTurn('3'),
      toolTurn('4'),
      turn([{ type: 'text', text: 'selesai' }], 'end_turn')
    ])

    await run(provider)

    const contents = (provider.sent[4] ?? [])
      .flatMap((message) => message.content)
      .filter((block): block is Extract<ContentBlock, { type: 'tool_result' }> =>
        block.type === 'tool_result'
      )
      .map((block) => block.content)

    expect(contents.some((content) => content.includes('elided'))).toBe(false)
    expect(contents.some((content) => content.includes('x'.repeat(2000)))).toBe(true)
  })

  it('retries a transient provider error and recovers', async () => {
    const inner = new FakeProvider([turn([{ type: 'text', text: 'pulih' }], 'end_turn')])
    let calls = 0
    const flaky: LLMProvider = {
      name: 'flaky',
      model: 'flaky-model',
      async *chat(params) {
        calls += 1
        if (calls === 1) {
          throw Object.assign(new Error('overloaded'), { status: 503 })
        }
        yield* inner.chat(params)
      }
    }

    await run(flaky)

    expect(calls).toBe(2)
    expect(events.at(-1)).toEqual({ type: 'end', runId: 'run-1', reason: 'complete' })
  })

  it('does not retry a permanent provider error', async () => {
    let calls = 0
    const broken: LLMProvider = {
      name: 'broken',
      model: 'broken-model',
      async *chat() {
        calls += 1
        throw new Error('kunci tidak valid')
      }
    }

    await run(broken)

    expect(calls).toBe(1)
    expect(events.at(-1)?.type).toBe('error')
  })

  it('says what to do when the model is out of usage', async () => {
    const spent: LLMProvider = {
      name: 'spent',
      model: 'spent-model',
      async *chat() {
        throw Object.assign(new Error('402 insufficient_quota'), { status: 402 })
      }
    }
    await run(spent)
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: '402 insufficient_quota\nThis model is out of usage. Pick another model from the model chip, or top up the account.'
    })
    expect(events.at(-1)).not.toHaveProperty('retryable')
  })

  it('makes an exhausted connection failure resumable and keeps its last partial reply', async () => {
    let calls = 0
    const disconnected: LLMProvider = {
      name: 'offline',
      model: 'offline-model',
      async *chat() {
        calls += 1
        yield { type: 'text_delta', text: 'bagian yang sudah diterima' }
        throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENETUNREACH' }, retryAfter: 0 })
      }
    }
    const session = new AgentSession(disconnected, allowAll, 'chat')
    await session.run({
      runId: 'offline', prompt: 'kerjakan panjang', signal: new AbortController().signal,
      emit: (event) => events.push(event)
    })

    // Retrying after words were shown would write the reply twice on screen.
    expect(calls).toBe(6)
    expect(events.filter((event) => event.type === 'text_delta')).toHaveLength(6)
    expect(events.at(-1)).toMatchObject({
      type: 'error', retryable: true, keptReplyModel: 'offline-model',
      message: 'Connection to offline dropped (fetch failed). The run was stopped; press Continue to pick it up. If it keeps failing, check your internet connection, not the provider settings.'
    })

    const recovered = new FakeProvider([turn([{ type: 'text', text: 'selesai setelah tersambung' }], 'end_turn')])
    session.useProvider(recovered)
    await session.run({
      runId: 'continued', prompt: CONTINUE_PROMPT, signal: new AbortController().signal,
      emit: () => undefined
    })
    expect(recovered.sent[0]?.map((message) => message.role)).toEqual(['user','assistant','user','assistant','user','assistant','user','assistant','user','assistant','user','assistant','user'])
    expect(recovered.sent[0]?.[1]?.content).toEqual([{ type: 'text', text: 'bagian yang sudah diterima' }])
  })

  it.each([429, 403])('hands HTTP %s to an eligible fallback before output and reports the new model', async status => {
    const limited: LLMProvider = {
      name: 'first',
      model: 'first-model',
      async *chat() {
        throw Object.assign(new Error('provider refusal'), { status })
      }
    }
    const spare = new FakeProvider([turn([{ type: 'text', text: 'dari cadangan' }], 'end_turn')])
    const failures: unknown[] = []
    const session = new AgentSession(limited, allowAll, 'code', root)
    session.useProvider(limited, (error) => {
      failures.push(error)
      return failures.length === 1 ? spare : null
    })

    const started = Date.now()
    await session.run({ runId: 'run-1', prompt: 'halo', signal: new AbortController().signal, emit: (event) => events.push(event) })

    // No backoff: the pool exists so a limit is not waited out.
    expect(Date.now() - started).toBeLessThan(900)
    expect(failures).toHaveLength(1)
    expect(events.find((event) => event.type === 'usage')).toMatchObject({ provider: 'fake', model: 'fake-model' })
    expect(events.at(-1)).toEqual({ type: 'end', runId: 'run-1', reason: 'complete' })
  })

  it('lets the error stand once the fallback has nothing left', async () => {
    let calls = 0
    const broken: LLMProvider = {
      name: 'broken',
      model: 'broken-model',
      async *chat() {
        calls += 1
        throw new Error('kunci tidak valid')
      }
    }
    const session = new AgentSession(broken, allowAll, 'code', root)
    session.useProvider(broken, () => null)

    await session.run({ runId: 'run-1', prompt: 'halo', signal: new AbortController().signal, emit: (event) => events.push(event) })

    expect(calls).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'kunci tidak valid' })
  })
})

it('retains all prompt turns that still fit the context budget', async () => {
  const provider = new FakeProvider([turn([{ type: 'text', text: 'ok' }], 'end_turn')])
  const session = new AgentSession(provider, allowAll, 'chat', null, [
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(400_000) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
    { role: 'user', content: [{ type: 'text', text: 'keep this prompt' }] }
  ])
  await session.run({ runId: 'trim', prompt: 'latest', signal: new AbortController().signal, emit: () => {} })
  expect(provider.sent[0]?.flatMap(m => m.content).filter(b => b.type === 'text').map(b => b.text)).toEqual([
    expect.stringContaining('Automatic context compaction'), 'keep this prompt', 'latest'
  ])
})
it('rejects simultaneous run calls before adding the second user prompt', async () => {
  const provider = new FakeProvider([turn([{ type: 'text', text: 'ok' }], 'end_turn')])
  const session = new AgentSession(provider, allowAll, 'chat')
  const params = { runId: 'one', prompt: 'first', signal: new AbortController().signal, emit: () => {} }
  const first = session.run(params)
  await expect(session.run({ ...params, runId: 'two', prompt: 'second' })).rejects.toThrow(/already active/)
  await first
  expect(session.snapshot().messages.filter(m => m.role === 'user')).toHaveLength(1)
})
it('does not execute a write if cancellation happens during authorization', async () => {
  const controller = new AbortController()
  const seen: AgentEvent[] = []
  const provider = new FakeProvider([turn([{ type: 'tool_use', id: 't', name: 'write_file', input: {path: 'cancelled.txt', content: 'bad'} }], 'tool_use')])
  const session = new AgentSession(provider, {authorize: async () => { controller.abort(); return true }}, 'code', root)
  await session.run({ runId: 'cancel', prompt: 'write', signal: controller.signal, emit: (event) => seen.push(event) })
  await expect(readFile(path.join(root, 'cancelled.txt'))).rejects.toThrow()
  expect(seen).toContainEqual(expect.objectContaining({
    type: 'tool_end', toolUseId: 't', ok: true,
    output: expect.stringContaining('did not reject')
  }))
  expect(seen).not.toContainEqual(expect.objectContaining({ rejected: true }))
})

it('cancels even when a provider ignores its abort signal', async () => {
  const controller = new AbortController()
  const provider: LLMProvider = { name: 'stalled', model: 'stalled', async *chat() {
    yield { type: 'text_delta', text: 'partial' }
    await new Promise(() => {})
  } }
  const session = new AgentSession(provider, allowAll, 'chat')
  const events: AgentEvent[] = []
  await session.run({ runId: 'stalled', prompt: 'start', signal: controller.signal, emit: (event) => {
    events.push(event)
    if (event.type === 'text_delta') controller.abort()
  } })
  expect(events.at(-1)).toMatchObject({type: 'end', reason: 'cancelled'})
})

it('keeps a reply cut off by a pause, so the resume continues it instead of writing it again', async () => {
  const controller = new AbortController()
  const sent: Message[][] = []
  let call = 0
  const provider: LLMProvider = { name: 'slow', model: 'slow', async *chat(params) {
    sent.push(structuredClone(params.messages))
    if (call++ === 0) {
      yield { type: 'text_delta', text: 'Bagian satu, ' }
      yield { type: 'text_delta', text: 'bagian dua' }
      await new Promise(() => {})
    }
    yield { type: 'response', response: turn([{ type: 'text', text: 'lanjutan' }], 'end_turn') }
  } }
  const session = new AgentSession(provider, allowAll, 'chat')
  let deltas = 0
  const ended: AgentEvent[] = []
  await session.run({ runId: 'paused', prompt: 'tulis panjang', signal: controller.signal, emit: (event) => {
    if (event.type === 'end') ended.push(event)
    if (event.type === 'text_delta' && ++deltas === 2) controller.abort()
  } })
  // The kept words are a turn, and a turn is owed a summary for its model.
  expect(ended).toEqual([{ type: 'end', runId: 'paused', reason: 'cancelled', keptReplyModel: 'slow' }])
  await session.run({ runId: 'resumed', prompt: CONTINUE_PROMPT, signal: new AbortController().signal, emit: () => {} })
  expect(sent[1]?.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
  expect(sent[1]?.[1]?.content).toEqual([{ type: 'text', text: 'Bagian satu, bagian dua' }])
})

it('does not keep a finished reply twice when the pause lands on the tools it asked for', async () => {
  const controller = new AbortController()
  const provider = new FakeProvider([
    turn([{ type: 'text', text: 'Membaca dulu.' }, { type: 'tool_use', id: 't1', name: 'list_directory', input: {} }], 'tool_use'),
    turn([{ type: 'text', text: 'selesai' }], 'end_turn')
  ])
  const session = new AgentSession(provider, allowAll, 'code', root)
  await session.run({ runId: 'paused', prompt: 'baca', signal: controller.signal, emit: (event) => {
    if (event.type === 'tool_start') controller.abort()
  } })
  const said = session.snapshot().messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content.filter((block) => block.type === 'text').map((block) => block.type === 'text' ? block.text : ''))
  expect(said).toEqual(['Membaca dulu.'])
  expect(session.snapshot().messages.at(-2)?.role).toBe('user')
  expect(session.snapshot().messages.at(-1)?.content).toEqual([
    { type: 'display', kind: 'notice', text: 'Paused.' }
  ])
})

it('keeps the full transcript even when replay history is trimmed', async () => {
  const provider = new FakeProvider([
    turn([{type:'text',text:'ok'}], 'end_turn'),
    turn([{type:'text',text:'again'}], 'end_turn')
  ])
  const session = new AgentSession(provider, allowAll, 'chat', null, [
    {role:'user',content:[{type:'text',text:'old'.repeat(150000)}]},
    {role:'assistant',content:[{type:'text',text:'old answer'}]}
  ])
  await session.run({runId:'trim',prompt:'new prompt',signal:new AbortController().signal,emit:()=>{}})
  expect(provider.sent[0]).toHaveLength(2)
  expect(provider.sent[0]?.[0]?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Automatic context compaction') })
  expect(session.snapshot().messages).toHaveLength(4)
  expect(session.revertLastTurn()).toBe('new prompt')
  await session.run({runId:'replacement',prompt:'replacement',signal:new AbortController().signal,emit:()=>{}})
  expect(provider.sent[1]?.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text)).toEqual([
    expect.stringContaining('Automatic context compaction'), 'replacement'
  ])
})
it('stops a single oversized prompt before calling the provider', async () => {
  const provider = new FakeProvider([])
  await new AgentSession(provider, allowAll, 'chat').run({runId:'huge',prompt:'x'.repeat(500000),signal:new AbortController().signal,emit:event=>events.push(event)})
  expect(provider.sent).toHaveLength(0)
  expect(events.at(-1)).toMatchObject({type:'error',message:expect.stringContaining('context budget')})
})

describe('follow-ups sent while a run is working', () => {
  function session(provider: LLMProvider): AgentSession {
    return new AgentSession(provider, allowAll, 'code', root)
  }

  function start(agent: AgentSession, controller = new AbortController()): Promise<void> {
    return agent.run({
      runId: 'run-1',
      prompt: 'kerjakan sesuatu',
      signal: controller.signal,
      emit: (event) => events.push(event)
    })
  }

  function followUpsIn(blocks: ContentBlock[]): { text: string; during: boolean }[] {
    return blocks.flatMap((block) =>
      block.type === 'text' && block.followUp !== undefined ? [block.followUp] : []
    )
  }

  it('is refused when nothing is running', () => {
    const agent = session(new FakeProvider([]))
    expect(agent.steer('tambah ini')).toBe(false)
  })

  it('rides with the tool results of the step in flight, and the run carries on', async () => {
    await writeFile(path.join(root, 'a.txt'), 'isi')
    let agent: AgentSession | null = null
    const provider = new FakeProvider(
      [
        turn([{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.txt' } }], 'tool_use'),
        turn([{ type: 'text', text: 'dua-duanya beres' }], 'end_turn')
      ],
      (index) => {
        // Sent while the model is still choosing its tool call.
        if (index === 0) expect(agent?.steer('tambah juga README')).toBe(true)
      }
    )
    agent = session(provider)
    await start(agent)

    const second = lastContent(provider, 1)
    expect(second[0]).toMatchObject({ type: 'tool_result', toolUseId: 't1' })
    expect(followUpsIn(second)).toEqual([{ text: 'tambah juga README', during: true }])
    // The model may keep, correct, or replace the task according to the user.
    const framed = second.find((block) => block.type === 'text')
    expect(framed?.type === 'text' ? framed.text : '').toMatch(/jika pengguna mengganti topik[\s\S]*fokus pada pesan ini[\s\S]*tambah juga README/)
    expect(events.filter((event) => event.type === 'end')).toEqual([
      { type: 'end', runId: 'run-1', reason: 'complete' }
    ])
    // Viewers are told the moment it was read, so the reply moves below it then.
    expect(events.filter((event) => event.type === 'steer_taken')).toEqual([{ type: 'steer_taken', runId: 'run-1' }])
  })

  it('keeps a run going that was about to finish', async () => {
    let agent: AgentSession | null = null
    const provider = new FakeProvider(
      [
        turn([{ type: 'text', text: 'selesai' }], 'end_turn'),
        turn([{ type: 'text', text: 'oke, itu juga' }], 'end_turn')
      ],
      (index) => {
        if (index === 0) agent?.steer('satu lagi')
      }
    )
    agent = session(provider)
    await start(agent)

    expect(provider.sent).toHaveLength(2)
    expect(followUpsIn(lastContent(provider, 1))).toEqual([{ text: 'satu lagi', during: true }])
    expect(events.filter((event) => event.type === 'end')).toHaveLength(1)
  })

  it('is kept in the history when the run is paused before taking it in', async () => {
    const controller = new AbortController()
    let agent: AgentSession | null = null
    const provider = new FakeProvider([turn([{ type: 'text', text: 'hampir' }], 'end_turn')], (index) => {
      if (index === 0) {
        agent?.steer('jangan lupa tes')
        controller.abort()
      }
    })
    agent = session(provider)
    await start(agent, controller)

    // Never read, so never announced as taken.
    expect(events.some((event) => event.type === 'steer_taken')).toBe(false)
    const history = agent.snapshot().messages
    const last = history.at(-1)
    expect(last?.role).toBe('user')
    expect(followUpsIn(last?.content ?? [])).toEqual([{ text: 'jangan lupa tes', during: false }])
    // Stopping refuses anything more.
    expect(agent.steer('lagi')).toBe(false)
  })
})

describe('taking an earlier prompt back', () => {
  const write = (id: string, content: string): LLMResponse =>
    turn([{ type: 'tool_use', id, name: 'write_file', input: { path: 'a.txt', content } }], 'tool_use')
  const done = turn([{ type: 'text', text: 'done' }], 'end_turn')

  it('removes that prompt and everything after it, files included', async () => {
    await writeFile(path.join(root, 'a.txt'), 'v0')
    const provider = new FakeProvider([write('w1', 'v1'), done, write('w2', 'v2'), done, done])
    const session = new AgentSession(provider, allowAll, 'code', root)
    for (const prompt of ['first', 'second']) {
      await session.run({ runId: prompt, prompt, signal: new AbortController().signal, emit: () => {} })
    }
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('v2')

    const taken = session.takeBack(2)
    expect(taken?.prompt).toBe('first')
    expect(taken?.removed.filter((message) => message.role === 'user' && message.content.some((block) => block.type === 'text'))).toHaveLength(2)
    expect(session.snapshot().messages).toHaveLength(0)
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('v0')

    // The replay was cut at the same place: the next run starts clean.
    await session.run({ runId: 'again', prompt: 'edited', signal: new AbortController().signal, emit: () => {} })
    expect(provider.sent.at(-1)?.map((message) => message.role)).toEqual(['user'])
  })

  it('hands back the attachments that rode with the prompt', async () => {
    const attachment = { name: 'r.pdf', path: '/tmp/r.pdf', workspacePath: null, kind: 'pdf' as const, size: 1, thumbnail: null }
    const session = new AgentSession(new FakeProvider([done]), allowAll, 'chat')
    await session.run({
      runId: 'a', prompt: 'summarise', signal: new AbortController().signal, emit: () => {},
      attachments: [{ type: 'text', text: 'Attachment: r.pdf', attachment }]
    })
    const taken = session.takeBack(1)
    expect(taken?.prompt).toBe('summarise')
    expect(taken?.attachments).toEqual([{ type: 'text', text: 'Attachment: r.pdf', attachment }])
  })

  it('does not count a resume as a prompt of its own', async () => {
    const session = new AgentSession(new FakeProvider([done, done, done]), allowAll, 'chat')
    await session.run({ runId: '1', prompt: 'typed one', signal: new AbortController().signal, emit: () => {} })
    await session.run({ runId: '2', prompt: 'typed two', signal: new AbortController().signal, emit: () => {} })
    await session.run({ runId: '3', prompt: CONTINUE_PROMPT, signal: new AbortController().signal, emit: () => {} })
    // One back is "typed two" — the resume after it goes with it.
    expect(session.takeBack(1)?.prompt).toBe('typed two')
    expect(session.snapshot().messages).toHaveLength(2)
  })

  it('answers null when there are not that many prompts', async () => {
    const session = new AgentSession(new FakeProvider([done]), allowAll, 'chat')
    await session.run({ runId: '1', prompt: 'only', signal: new AbortController().signal, emit: () => {} })
    expect(session.takeBack(2)).toBeNull()
    expect(session.snapshot().messages).toHaveLength(2)
  })
})

describe('semantic compaction', () => {
  const long = (label: string): Message[] => [
    { role: 'user', content: [{ type: 'text', text: `${label} ${'x'.repeat(200_000)}` }] },
    { role: 'assistant', content: [{ type: 'text', text: `${label} answered` }] }
  ]

  it('replaces the dropped turns with a memory the model writes', async () => {
    const provider = new FakeProvider([turn([{ type: 'text', text: 'ok' }], 'end_turn')])
    const session = new AgentSession(provider, allowAll, 'chat', null, [...long('first'), ...long('second')])
    await session.run({ runId: 'c', prompt: 'latest', signal: new AbortController().signal, emit: (event) => events.push(event) })

    const first = provider.sent[0]?.[0]?.content[0]
    expect(first?.type === 'text' ? first.text : '').toContain('MODEL MEMORY')
    // The model was shown the turns it summarised, in readable form.
    expect(provider.compactions[0]).toContain('USER: first')
    expect(provider.compactions[0]).toContain('ASSISTANT: first answered')
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'notice', text: expect.stringContaining('context compacted') }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'usage', subagent: true }))
    // The record is never cut, only the replay.
    expect(session.snapshot().messages).toHaveLength(6)
  })

  it('falls back to the deterministic digest when the summary fails', async () => {
    const provider = new FakeProvider([turn([{ type: 'text', text: 'ok' }], 'end_turn')])
    provider.memory = null
    const session = new AgentSession(provider, allowAll, 'chat', null, [...long('first'), ...long('second')])
    await session.run({ runId: 'c', prompt: 'latest', signal: new AbortController().signal, emit: (event) => events.push(event) })
    const first = provider.sent[0]?.[0]?.content[0]
    expect(first?.type === 'text' ? first.text : '').toContain('User: first')
    expect(events.at(-1)).toEqual({ type: 'end', runId: 'c', reason: 'complete' })
  })

  it('leaves headroom so the next step does not compact again', async () => {
    const provider = new FakeProvider([
      turn([{ type: 'tool_use', id: 't', name: 'todo_write', input: { items: [{ content: 'a', status: 'in_progress' }] } }], 'tool_use'),
      turn([{ type: 'text', text: 'ok' }], 'end_turn')
    ])
    const session = new AgentSession(provider, allowAll, 'chat', root, [...long('first'), ...long('second')])
    await session.run({ runId: 'c', prompt: 'latest', signal: new AbortController().signal, emit: () => {} })
    expect(provider.compactions).toHaveLength(1)
  })

  it('compacts on request between runs', async () => {
    const provider = new FakeProvider([
      turn([{ type: 'text', text: 'one' }], 'end_turn'),
      turn([{ type: 'text', text: 'two' }], 'end_turn'),
      turn([{ type: 'text', text: 'three' }], 'end_turn')
    ])
    const session = new AgentSession(provider, allowAll, 'chat')
    for (const prompt of ['p1', 'p2']) {
      await session.run({ runId: prompt, prompt, signal: new AbortController().signal, emit: () => {} })
    }
    const result = await session.compact(new AbortController().signal)
    expect(result.after).toBeLessThanOrEqual(result.before + 50)
    // Compacting again has nothing new to fold in.
    await session.compact(new AbortController().signal)
    expect(provider.compactions).toHaveLength(1)

    await session.run({ runId: 'p3', prompt: 'p3', signal: new AbortController().signal, emit: () => {} })
    const replay = provider.sent[2]?.flatMap((message) => message.content).filter((block) => block.type === 'text').map((block) => block.type === 'text' ? block.text : '')
    expect(replay?.[0]).toContain('MODEL MEMORY')
    expect(replay).toContain('p2')
    expect(replay).not.toContain('p1')
  })
})

describe('sub-agents', () => {
  /** Answers as the parent or as a sub-agent, depending on whose system prompt it got. */
  function scripted(): LLMProvider & { childTools: string[][]; active: number; peak: number } {
    const provider = {
      name: 'script',
      model: 'script-model',
      childTools: [] as string[][],
      active: 0,
      peak: 0,
      async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
        const last = params.messages.at(-1)
        const answered = last?.content.some((block) => block.type === 'tool_result') === true
        if (params.system.includes('sub-agent of anticode')) {
          provider.childTools.push(params.tools.map((tool) => tool.name))
          provider.active += 1
          provider.peak = Math.max(provider.peak, provider.active)
          await new Promise((resolve) => setTimeout(resolve, 20))
          provider.active -= 1
          const asked = params.messages[0]?.content.find((block) => block.type === 'text')
          const question = asked?.type === 'text' ? asked.text : ''
          yield {
            type: 'response',
            response: answered
              ? turn([{ type: 'text', text: `report for ${question}` }], 'end_turn')
              : turn([{ type: 'tool_use', id: `r-${question}`, name: 'read_file', input: { path: 'a.txt' } }], 'tool_use')
          }
          return
        }
        yield {
          type: 'response',
          response: answered
            ? turn([{ type: 'text', text: 'merged' }], 'end_turn')
            : turn([
                { type: 'tool_use', id: 'task-1', name: 'task', input: { description: 'one', prompt: 'alpha' } },
                { type: 'tool_use', id: 'task-2', name: 'task', input: { description: 'two', prompt: 'beta' } }
              ], 'tool_use')
        }
      }
    }
    return provider
  }

  it('runs several tasks in parallel and returns only their reports', async () => {
    await writeFile(path.join(root, 'a.txt'), 'SECRET FILE BODY')
    const provider = scripted()
    const session = new AgentSession(provider, allowAll, 'code', root)
    await session.run({ runId: 'run-1', prompt: 'investigate', signal: new AbortController().signal, emit: (event) => events.push(event) })

    expect(provider.peak).toBe(2)
    const results = session.snapshot().messages
      .flatMap((message) => message.content)
      .filter((block): block is Extract<ContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')
    expect(results.map((block) => block.content)).toEqual([
      expect.stringContaining('report for alpha'),
      expect.stringContaining('report for beta')
    ])
    // What the sub-agents read stays in their own context.
    expect(JSON.stringify(session.snapshot().messages)).not.toContain('SECRET FILE BODY')
    expect(events.at(-1)).toEqual({ type: 'end', runId: 'run-1', reason: 'complete' })
  })

  it('gives a sub-agent read-only tools and no task of its own', async () => {
    await writeFile(path.join(root, 'a.txt'), 'x')
    const provider = scripted()
    await new AgentSession(provider, allowAll, 'code', root).run({ runId: 'run-1', prompt: 'go', signal: new AbortController().signal, emit: (event) => events.push(event) })
    for (const offered of provider.childTools) {
      expect(offered).toContain('read_file')
      for (const name of ['task', 'write_file', 'edit_file', 'run_command', 'delete_file', 'browser_navigate']) {
        expect(offered).not.toContain(name)
      }
    }
  })

  it('reports its steps as progress and its tokens as sub-agent usage', async () => {
    await writeFile(path.join(root, 'a.txt'), 'x')
    await new AgentSession(scripted(), allowAll, 'code', root).run({ runId: 'run-1', prompt: 'go', signal: new AbortController().signal, emit: (event) => events.push(event) })
    const progress = events.filter((event) => event.type === 'tool_progress')
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolUseId: 'task-1', text: 'read_file a.txt' }),
      expect.objectContaining({ toolUseId: 'task-2', text: 'read_file a.txt' })
    ]))
    const usage = events.filter((event) => event.type === 'usage')
    expect(usage.filter((event) => event.type === 'usage' && event.subagent === true)).toHaveLength(4)
    expect(usage.filter((event) => event.type === 'usage' && event.subagent !== true)).toHaveLength(2)
  })

  it('is offered in antichat too', () => {
    const offered = new AgentSession(new FakeProvider([]), allowAll, 'chat', root)
    expect((offered as unknown as { toolset: () => { name: string }[] }).toolset().some((tool) => tool.name === 'task')).toBe(true)
  })

  it('hands the user instructions down to the sub-agent', async () => {
    await writeFile(path.join(root, 'a.txt'), 'x')
    const childSystems: string[] = []
    const provider: LLMProvider = { name: 'script', model: 'script-model', async *chat(params) {
      if (params.system.includes('sub-agent of anticode')) {
        childSystems.push(params.system)
        yield { type: 'response', response: turn([{ type: 'text', text: 'child report' }], 'end_turn') }
        return
      }
      const answered = params.messages.at(-1)?.content.some((block) => block.type === 'tool_result') === true
      yield {
        type: 'response',
        response: answered
          ? turn([{ type: 'text', text: 'merged' }], 'end_turn')
          : turn([{ type: 'tool_use', id: 'task-1', name: 'task', input: { description: 'one', prompt: 'alpha' } }], 'tool_use')
      }
    } }
    const given = { global: 'Answer in Indonesian.', session: 'Focus on billing.' }
    await new AgentSession(provider, allowAll, 'code', root, [], 'scope', { instructions: () => given })
      .run({ runId: 'run-1', prompt: 'go', signal: new AbortController().signal, emit: () => {} })
    expect(childSystems.length).toBeGreaterThan(0)
    for (const system of childSystems) {
      expect(system).toContain('for every session:\n\nAnswer in Indonesian.')
      expect(system).toContain('for this session:\n\nFocus on billing.')
    }
  })
})

describe('titleOf', () => {
  it('names a session after the typed prompt, not the file sent with it', () => {
    const attachment = { name: 'Receipt-2844-21.pdf', path: '/tmp/r.pdf', workspacePath: null, kind: 'pdf' as const, size: 1, thumbnail: null }
    expect(titleOf([{
      role: 'user',
      content: [
        { type: 'text', text: 'Attachment: Receipt-2844-21.pdf (pdf, 1 bytes)', attachment },
        { type: 'text', text: 'Ringkas struk ini' }
      ]
    }])).toBe('Ringkas struk ini')
    expect(titleOf([])).toBe('New session')
  })
})

describe('antichat', () => {
  it('loads document, browser, and media capabilities on demand in antichat', async () => {
    let offered: string[] = []
    const provider: LLMProvider = { name: 'spy', model: 'spy', async *chat(params) {
      if (offered.length === 0) {
        offered = params.tools.map((tool) => tool.name)
        expect(offered).toContain('load_tools')
        expect(offered).not.toContain('read_excel')
        yield { type: 'response', response: turn([{ type: 'tool_use', id: 'load', name: 'load_tools', input: { groups: ['documents', 'browser', 'media'] } }], 'tool_use') }
        return
      }
      offered = params.tools.map((tool) => tool.name)
      yield { type: 'response', response: turn([{ type: 'text', text: 'ok' }], 'end_turn') }
    } }
    await new AgentSession(provider, allowAll, 'chat', root).run({ runId: 'tools', prompt: 'hai', signal: new AbortController().signal, emit: () => {} })
    expect(offered).toEqual(expect.arrayContaining([
      'read_excel',
      'format_excel_cells',
      'write_docx',
      'edit_file',
      'run_command',
      'delete_file',
      'fetch_url',
      'browser_navigate',
      'generate_image',
      'task',
      'screenshot'
    ]))
  })

  it('uses the same approval gate as anticode for mutations', async () => {
    let asked = 0
    const provider = new FakeProvider([
      turn([{ type: 'tool_use', id: 'w', name: 'write_file', input: { path: 'hasil.txt', content: 'jadi' } }], 'tool_use'),
      turn([{ type: 'text', text: 'selesai' }], 'end_turn')
    ])
    const gate = { authorize: async () => { asked += 1; return false } }
    await new AgentSession(provider, gate, 'chat', root).run({ runId: 'ask', prompt: 'tulis', signal: new AbortController().signal, emit: () => {} })
    expect(asked).toBe(1)
    await expect(readFile(path.join(root, 'hasil.txt'), 'utf8')).rejects.toThrow()
  })

  it('edits and runs commands inside its own folder', async () => {
    await writeFile(path.join(root, 'catatan.txt'), 'halo dunia')
    const provider = new FakeProvider([
      turn([
        { type: 'tool_use', id: 'edit', name: 'edit_file', input: { path: 'catatan.txt', old_string: 'dunia', new_string: 'semua' } },
        { type: 'tool_use', id: 'shell', name: 'run_command', input: { command: 'touch pwned' } }
      ], 'tool_use'),
      turn([{ type: 'text', text: 'selesai' }], 'end_turn')
    ])
    await new AgentSession(provider, allowAll, 'chat', root).run({ runId: 'edit', prompt: 'ganti', signal: new AbortController().signal, emit: (event) => events.push(event) })
    expect(await readFile(path.join(root, 'catatan.txt'), 'utf8')).toBe('halo semua')
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_end', toolUseId: 'shell', ok: true }))
    expect(await readFile(path.join(root, 'pwned'), 'utf8')).toBe('')
  })
})

it("puts the user's instructions in the system prompt, read fresh on every request", async () => {
  const systems: string[] = []
  const provider: LLMProvider = { name: 'spy', model: 'spy', async *chat(params) {
    systems.push(params.system)
    yield { type: 'response', response: turn([{ type: 'text', text: 'ok' }], 'end_turn') }
  } }
  const given = { global: 'Answer in Indonesian.', session: '' }
  const session = new AgentSession(provider, allowAll, 'chat', null, [], 'scope', { instructions: () => given })
  await session.run({ runId: '1', prompt: 'a', signal: new AbortController().signal, emit: () => {} })
  given.session = 'Focus on billing.'
  await session.run({ runId: '2', prompt: 'b', signal: new AbortController().signal, emit: () => {} })
  expect(systems[0]).toContain('for every session:\n\nAnswer in Indonesian.')
  expect(systems[0]).not.toContain('for this session')
  expect(systems[1]).toMatch(/Answer in Indonesian\.[\s\S]*for this session:\n\nFocus on billing\./)
})

it('instructs coding models to batch independent tools instead of spending one turn per call', async () => {
  const systems: string[] = []
  const provider: LLMProvider = {
    name: 'batch-audit',
    model: 'batch-audit-model',
    async *chat(params) {
      systems.push(params.system)
      yield { type: 'response', response: turn([{ type: 'text', text: 'done' }], 'end_turn') }
    }
  }

  await run(provider)

  expect(systems[0]).toContain('issue those independent tool calls together in that same response')
  expect(systems[0]).toContain('Never spend a model turn only updating todo_write')
  expect(systems[0]).toContain('Only serialize calls when one result is genuinely required')
})

it.each([false, true])('reduces a 413 historical-image payload once without mutating originals (still rejected: %s)', async stillRejected => {
  const sent: Message[][] = []
  const provider: LLMProvider = { name: 'fixture', model: 'vision-fixture', async *chat(params) {
    sent.push(structuredClone(params.messages))
    if (sent.length === 1 || stillRejected) throw Object.assign(new Error('413 Request too large'), { status: 413 })
    yield { type: 'response', response: turn([{ type: 'text', text: 'Done' }], 'end_turn') }
  } }
  const original: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'earlier screenshot' }, { type: 'image', mediaType: 'image/png', data: 'a'.repeat(50000) }] }]
  const session = new AgentSession(provider, allowAll, 'chat', null, original, 'payload-test', { tools: [] })
  await session.run({ runId: 'payload-test', prompt: 'Continue from confirmed results', signal: new AbortController().signal, emit: event => events.push(event) })
  expect(sent).toHaveLength(2)
  expect(JSON.stringify(sent[1]).length).toBeLessThan(JSON.stringify(sent[0]).length)
  expect(JSON.stringify(session.snapshot().messages)).toContain('a'.repeat(50000))
  expect(sent[1]?.at(-1)?.content).toEqual(sent[0]?.at(-1)?.content)
  if (stillRejected) expect(events.some(event => event.type === 'error' && event.message.includes('HTTP 413'))).toBe(true)
  else expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'complete' })
})

it('does not retry a 413 without removable historical images or a generic 403', async () => {
  for (const status of [413, 403]) {
    let requests = 0
    const provider: LLMProvider = { name: 'fixture', model: 'fixture', async *chat() {
      requests++
      throw Object.assign(new Error(`HTTP ${status}`), { status })
    } }
    await run(provider)
    expect(requests).toBe(1)
  }
})

it('recovers a text-only payload limit locally without repeating tools', async () => {
  const sent: Message[][] = []
  const provider: LLMProvider = { name: 'fixture', model: 'fixture', async *chat(params) {
    sent.push(structuredClone(params.messages))
    if (sent.length === 1) throw Object.assign(new Error('413 Request too large'), { status: 413 })
    yield { type: 'response', response: turn([{ type: 'text', text: 'Done' }], 'end_turn') }
  } }
  const oldText = 'Earlier verified results '.repeat(5000)
  const history: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'Original goal' }] }, { role: 'assistant', content: [{ type: 'text', text: oldText }] }]
  const session = new AgentSession(provider, allowAll, 'chat', null, history, 'payload-text', { tools: [] })
  await session.run({ runId: 'payload-text', prompt: 'Finish from verified work', signal: new AbortController().signal, emit: event => events.push(event) })
  expect(sent).toHaveLength(2)
  expect(JSON.stringify(sent[1]).length).toBeLessThan(JSON.stringify(sent[0]).length)
  expect(JSON.stringify(sent[1])).toContain('Finish from verified work')
  expect(JSON.stringify(session.snapshot().messages)).toContain(oldText)
  expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'complete' })
})

it('locally condenses oversized key-limited history once while preserving the original transcript', async () => {
  const oldText = 'Earlier verified work and decisions. '.repeat(5000)
  const sent: Message[][] = []
  const provider: LLMProvider = {
    name: 'fixture', model: 'fixture-large-window',
    async *chat(params) {
      sent.push(structuredClone(params.messages))
      if (sent.length === 1) throw Object.assign(new Error('Prompt tokens limit exceeded: 45000 > 12000'), { status: 402 })
      yield { type: 'response', response: turn([{ type: 'text', text: 'OK' }], 'end_turn') }
    }
  }
  const session = new AgentSession(provider, allowAll, 'chat', null, [{ role: 'user', content: [{ type: 'text', text: 'Keep the original project goal.' }] }, { role: 'assistant', content: [{ type: 'text', text: oldText }] }], 'limit-test', { tools: [] })
  await session.run({ runId: 'limit-test', prompt: 'Current request remains intact.', signal: new AbortController().signal, emit: event => events.push(event) })
  expect(sent.length).toBe(2)
  expect(JSON.stringify(sent[1]).length).toBeLessThan(JSON.stringify(sent[0]).length)
  expect(JSON.stringify(sent[1])).toContain('Current request remains intact.')
  expect(events.some(event => event.type === 'notice' && event.text.includes('diringkas secara lokal'))).toBe(true)
  expect(JSON.stringify(session.snapshot().messages)).toContain(oldText)
})

it('reduces the replay again for the next route instead of refusing it on the first route evidence', async () => {
  const sent: string[] = []
  // The fallback hands back the provider itself, not a route name. Both routes
  // refuse the unreduced replay, as a credit-limited key does.
  const wide: LLMProvider = { name: 'wide-key', model: 'large', async *chat(params) {
    const replay = JSON.stringify(params.messages)
    sent.push('wide:' + replay.length)
    if (replay.length > 20000) throw new InputRequestLimitError(45000, 12000)
    yield { type: 'response', response: turn([{ type: 'text', text: 'Continued on the wider route.' }], 'end_turn') }
  } }
  // A key whose request limit is below its own instructions and tools cannot
  // be reduced into: it is refused on every attempt, which is what used to
  // consume the whole turn's single reduction before the next route saw it.
  const tight: LLMProvider = { name: 'tight-key', model: 'small', async *chat(params) {
    sent.push('tight:' + JSON.stringify(params.messages).length)
    throw new InputRequestLimitError(45000, 12000)
  } }
  const session = new AgentSession(tight, allowAll, 'chat', null, [{ role: 'user', content: [{ type: 'text', text: 'Keep the original project goal.' }] }, { role: 'assistant', content: [{ type: 'text', text: 'past work '.repeat(18000) }] }], 'rotation', { tools: [] })
  session.useProvider(tight, () => wide)
  await session.run({ runId: 'rotation', prompt: 'Carry on.', signal: new AbortController().signal, emit: event => events.push(event) })
  expect(sent.map(entry => entry.split(':')[0])).toEqual(['tight', 'tight', 'wide'])
  expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'complete' })
  // One line for the whole turn: the second route is reduced without another
  // identical notice in the transcript.
  const lines = JSON.stringify(session.snapshot().messages).match(/Konteks melebihi batas request key/g) ?? []
  expect(lines).toHaveLength(1)
})

it('says the reduction line once per turn, and again in a later turn', async () => {
  let requests = 0
  // A normal session whose route is only occasionally squeezed by the key
  // limit: nothing about the fix may silence the line in a later turn.
  const provider: LLMProvider = { name: 'fixture', model: 'fixture-large-window', async *chat(params) {
    requests++
    const replay = JSON.stringify(params.messages)
    if (requests % 2 === 1) throw new InputRequestLimitError(9000 + replay.length / 4, 12000)
    yield { type: 'response', response: turn([{ type: 'text', text: 'past work '.repeat(4000) }], 'end_turn') }
  } }
  const session = new AgentSession(provider, allowAll, 'chat', null, [{ role: 'user', content: [{ type: 'text', text: 'Old goal' }] }, { role: 'assistant', content: [{ type: 'text', text: 'past work '.repeat(2000) }] }], 'per-turn', { tools: [] })
  const send = (prompt: string) => session.run({ runId: prompt, prompt, signal: new AbortController().signal, emit: event => events.push(event) })
  await send('First request')
  await send('Second request')
  const lines = JSON.stringify(session.snapshot().messages).match(/Konteks melebihi batas request key/g) ?? []
  expect(lines).toHaveLength(2)
})

it('retries once with a text stand-in when the provider says it rejects images', async () => {
  const sent: string[] = []
  const provider: LLMProvider = { name: 'fixture', model: 'text-only-x', async *chat(params) {
    const replay = JSON.stringify(params.messages)
    sent.push(replay)
    if (replay.includes('"type":"image"')) throw Object.assign(new Error("400 Model 'text-only-x' does not accept image input."), { status: 400 })
    yield { type: 'response', response: turn([{ type: 'text', text: 'ok' }], 'end_turn') }
  } }
  const session = new AgentSession(provider, allowAll, 'chat', null, [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' } as never] }, { role: 'assistant', content: [{ type: 'text', text: 'seen' }] }], 'img', { tools: [] })
  await session.run({ runId: 'img', prompt: 'lanjut', signal: new AbortController().signal, emit: event => events.push(event) })
  expect(sent).toHaveLength(2)
  expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'complete' })
})

it('does not carry an image rejection to another provider serving the same model', async () => {
  const received: boolean[] = []
  const rejecting: LLMProvider = { id: 'account-a', name: 'fixture', model: 'deepseek-v4.1-flash', async *chat(params) {
    if (JSON.stringify(params.messages).includes('"type":"image"')) throw new Error('400 does not accept image input')
    yield { type: 'response', response: turn([{ type: 'text', text: 'text reply' }], 'end_turn') }
  } }
  const vision: LLMProvider = { id: 'account-b', name: 'fixture', model: rejecting.model, async *chat(params) {
    received.push(JSON.stringify(params.messages).includes('"type":"image"'))
    yield { type: 'response', response: turn([{ type: 'text', text: 'vision reply' }], 'end_turn') }
  } }
  const session = new AgentSession(rejecting, allowAll, 'chat', null, [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] }], 'route-images', { tools: [] })
  const send = (prompt: string) => session.run({ runId: prompt, prompt, signal: new AbortController().signal, emit: event => events.push(event) })
  await send('first')
  expect(JSON.stringify(events)).toContain('Rute provider ini menolak input gambar')
  expect(JSON.stringify(events)).not.toContain('Model ini hanya membaca teks')
  session.useProvider(vision)
  await send('second')
  expect(received).toEqual([true])
  expect(JSON.stringify(session.snapshot().messages)).toContain('"type":"image"')
})

it('does not repeat a key-limit compaction indefinitely if a smaller request is refused too', async () => {
  let requests = 0
  const provider: LLMProvider = { name: 'fixture', model: 'fixture-large-window', async *chat() {
    requests++
    throw Object.assign(new Error('Prompt tokens limit exceeded: 45000 > 12000'), { status: 402 })
  } }
  const session = new AgentSession(provider, allowAll, 'chat', null, [{ role: 'user', content: [{ type: 'text', text: 'Old goal' }] }, { role: 'assistant', content: [{ type: 'text', text: 'past work '.repeat(18000) }] }], 'limit-retry', { tools: [] })
  await session.run({ runId: 'limit-retry', prompt: 'New request', signal: new AbortController().signal, emit: event => events.push(event) })
  expect(requests).toBe(2)
  expect(events.some(event => event.type === 'error' && event.message.includes('out of usage'))).toBe(false)
})

it('reduces large tool results within a single turn without replaying the tool or losing the original transcript', async () => {
  await writeFile(path.join(root, 'large.txt'), 'Evidence before.\n' + 'verified evidence '.repeat(800) + '\nEvidence after.')
  const sent: Message[][] = []
  const provider: LLMProvider = { name: 'fixture', model: 'small', async *chat(params) {
    sent.push(structuredClone(params.messages))
    if (sent.length === 1) {
      yield { type: 'response', response: turn([{ type: 'tool_use', id: 'read-once', name: 'read_file', input: { path: 'large.txt' } }], 'tool_use') }
    } else if (sent.length === 2) throw new InputRequestLimitError(Math.ceil(JSON.stringify(params.messages).length / 4) + 200, 2500)
    else yield { type: 'response', response: turn([{ type: 'text', text: 'Done using saved evidence.' }], 'end_turn') }
  } }
  const session = new AgentSession(provider, allowAll, 'code', root)
  await session.run({ runId: 'small', prompt: 'Read the evidence and finish.', signal: new AbortController().signal, emit: event => events.push(event) })
  expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'complete' })
  expect(sent).toHaveLength(3)
  expect(JSON.stringify(sent[2])).toContain('Read the evidence and finish.')
  expect(JSON.stringify(sent[2])).toContain('do not replay this completed call')
  expect(JSON.stringify(sent[2]).length).toBeLessThan(JSON.stringify(sent[1]).length)
  expect(events.filter(event => event.type === 'tool_end')).toHaveLength(1)
  expect(JSON.stringify(session.snapshot()).length).toBeGreaterThan(JSON.stringify(sent[2]).length)
})

it('explains an irreducible request and locally blocks an unchanged Continue only on that route', async () => {
  let requests = 0
  const small: LLMProvider = { name: 'small', model: 'fixture', async *chat() {
    requests++
    throw new InputRequestLimitError(13114, 4064)
  } }
  const session = new AgentSession(small, allowAll, 'chat', null, [], 'small', { tools: [] })
  const send = (prompt: string) => session.run({ runId: 'small', prompt, signal: new AbortController().signal, emit: event => events.push(event) })
  await send('Finish the task.')
  expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('instructions and tools') })
  await send(CONTINUE_PROMPT)
  expect(requests).toBe(1)
  expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('larger request allowance') })
  session.useProvider(new FakeProvider([turn([{ type: 'text', text: 'Larger route done.' }], 'end_turn')]))
  await send(CONTINUE_PROMPT)
  expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'complete' })
})

it('recovers automatically after a partial network response and finishes without re-executing a completed write', async () => {
  let requests=0
  const good = new FakeProvider([turn([{type:'text',text:'Verified the saved result; finished.'}],'end_turn')])
  const flaky:LLMProvider={name:'fixture',model:'fixture',async *chat(params){
    requests++
    if(requests===1){yield {type:'text_delta',text:'The completed work is saved.'};throw new Error('fetch failed')}
    yield* good.chat(params)
  }}
  const session=new AgentSession(flaky,allowAll,'code',root)
  await session.run({runId:'auto-resume',prompt:'Finish the task',signal:new AbortController().signal,emit:event=>events.push(event)})
  expect(requests).toBe(2)
  expect(events.at(-1)).toMatchObject({type:'end',reason:'complete'})
  expect(good.sent[0]?.flatMap(m=>m.content).some(b=>b.type==='text'&&b.text.includes('last confirmed tool results'))).toBe(true)
})

it('does not abort useful work because one familiar file is checked alongside new evidence', async () => {
  for(const name of ['common','a','b','c'])await writeFile(path.join(root,name+'.txt'),name)
  const provider=new FakeProvider(['a','b','c'].map((name,index)=>turn([
    {type:'tool_use',id:'common-'+index,name:'read_file',input:{path:'common.txt'}},
    {type:'tool_use',id:'fresh-'+index,name:'read_file',input:{path:name+'.txt'}}
  ],'tool_use')).concat([turn([{type:'text',text:'Finished with new evidence.'}],'end_turn')]))
  await run(provider)
  expect(events.at(-1)).toMatchObject({type:'end',reason:'complete'})
})
