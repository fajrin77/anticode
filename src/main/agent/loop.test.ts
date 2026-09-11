import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/ipc'
import { AgentSession, titleOf } from './loop'
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

  constructor(
    private readonly turns: LLMResponse[],
    private readonly onTurn?: (index: number) => void
  ) {}

  async *chat(params: ChatParams): AsyncIterable<ProviderEvent> {
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
    expect(replayed).toHaveLength(1)
    expect(replayed[0]?.role).toBe('user')
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

  it('stubs old tool outputs and keeps recent turns verbatim', async () => {
    await writeFile(path.join(root, 'a.txt'), 'x'.repeat(2000))
    const toolTurn = (id: string): LLMResponse =>
      turn([{ type: 'tool_use', id, name: 'read_file', input: { path: 'a.txt' } }], 'tool_use')
    const provider = new FakeProvider([
      toolTurn('t1'),
      toolTurn('t2'),
      toolTurn('t3'),
      toolTurn('t4'),
      turn([{ type: 'text', text: 'selesai' }], 'end_turn')
    ])

    await run(provider)

    const contents = (provider.sent[4] ?? [])
      .flatMap((message) => message.content)
      .filter((block): block is Extract<ContentBlock, { type: 'tool_result' }> =>
        block.type === 'tool_result'
      )
      .map((block) => block.content)

    expect(contents.some((content) => content.includes('elided'))).toBe(true)
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

  it('hands a rate-limited turn to the fallback at once and reports the new model', async () => {
    const limited: LLMProvider = {
      name: 'first',
      model: 'first-model',
      async *chat() {
        throw Object.assign(new Error('rate limited'), { status: 429 })
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
  expect(provider.sent[0]?.flatMap(m => m.content).filter(b => b.type === 'text').map(b => b.text)).toEqual(['keep this prompt', 'latest'])
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
  const provider = new FakeProvider([turn([{ type: 'tool_use', id: 't', name: 'write_file', input: {path: 'cancelled.txt', content: 'bad'} }], 'tool_use')])
  const session = new AgentSession(provider, {authorize: async () => { controller.abort(); return true }}, 'code', root)
  await session.run({ runId: 'cancel', prompt: 'write', signal: controller.signal, emit: () => {} })
  await expect(readFile(path.join(root, 'cancelled.txt'))).rejects.toThrow()
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

it('keeps the full transcript even when replay history is trimmed', async () => {
  const provider = new FakeProvider([turn([{type:'text',text:'ok'}], 'end_turn')])
  const session = new AgentSession(provider, allowAll, 'chat', null, [
    {role:'user',content:[{type:'text',text:'old'.repeat(150000)}]},
    {role:'assistant',content:[{type:'text',text:'old answer'}]}
  ])
  await session.run({runId:'trim',prompt:'new prompt',signal:new AbortController().signal,emit:()=>{}})
  expect(provider.sent[0]).toHaveLength(1)
  expect(session.snapshot().messages).toHaveLength(4)
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
    // The model reads it framed as an addition to the task, not a new one.
    const framed = second.find((block) => block.type === 'text')
    expect(framed?.type === 'text' ? framed.text : '').toMatch(/lanjutkan, dan kerjakan juga ini[\s\S]*tambah juga README/)
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
  it('offers document tools only, with no terminal, deleting, or network', async () => {
    let offered: string[] = []
    const provider: LLMProvider = { name: 'spy', model: 'spy', async *chat(params) {
      offered = params.tools.map((tool) => tool.name)
      yield { type: 'response', response: turn([{ type: 'text', text: 'ok' }], 'end_turn') }
    } }
    await new AgentSession(provider, allowAll, 'chat', root).run({ runId: 'tools', prompt: 'hai', signal: new AbortController().signal, emit: () => {} })
    expect(offered).toEqual(expect.arrayContaining(['read_excel', 'format_excel_cells', 'write_docx', 'edit_file']))
    for (const name of ['run_command', 'delete_file', 'fetch_url', 'browser_navigate']) expect(offered).not.toContain(name)
  })

  it('writes without asking, since it only ever touches its own copies', async () => {
    let asked = 0
    const provider = new FakeProvider([
      turn([{ type: 'tool_use', id: 'w', name: 'write_file', input: { path: 'hasil.txt', content: 'jadi' } }], 'tool_use'),
      turn([{ type: 'text', text: 'selesai' }], 'end_turn')
    ])
    const gate = { authorize: async () => { asked += 1; return false } }
    await new AgentSession(provider, gate, 'chat', root).run({ runId: 'ask', prompt: 'tulis', signal: new AbortController().signal, emit: () => {} })
    expect(asked).toBe(0)
    expect(await readFile(path.join(root, 'hasil.txt'), 'utf8')).toBe('jadi')
  })

  it('edits a file in its own folder, and runs nothing it was not offered', async () => {
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
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_end', toolUseId: 'shell', ok: false, output: 'Unknown tool: run_command' }))
    await expect(readFile(path.join(root, 'pwned'))).rejects.toThrow()
  })
})
