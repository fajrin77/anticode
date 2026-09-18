import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { QuestionCoordinator } from './question'
import { askQuestionTool } from './tools/askQuestion'
import { setQuestionGateway } from './question-gateway'
import type { ToolContext } from './tools/types'

function contents(): WebContents {
  return Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() }) as unknown as WebContents
}

describe('question coordinator', () => {
  it('delivers the clicked option to the waiting run', async () => {
    const target = contents()
    const seen: string[] = []
    const gate = new QuestionCoordinator(() => target, undefined, (request) => seen.push(request.question))
    const asked = gate.ask({
      runId: 'r', sessionId: 's', question: 'Mana?', options: [{ id: 'a', label: 'A' }], allowCustom: true, signal: new AbortController().signal
    })
    const pending = gate.listPending()
    expect(pending).toHaveLength(1)
    expect(seen).toEqual(['Mana?'])
    gate.resolve(pending[0]!.requestId, { optionId: 'a', text: '' })
    await expect(asked).resolves.toMatchObject({ optionId: 'a', text: '' })
    expect(gate.listPending()).toHaveLength(0)
  })

  it('settles unanswered when the window is gone or the run is cancelled', async () => {
    const gone = new QuestionCoordinator(() => null)
    await expect(gone.ask({
      runId: 'r', sessionId: 's', question: 'Mana?', options: [{ id: 'a', label: 'A' }], allowCustom: false, signal: new AbortController().signal
    })).resolves.toMatchObject({ optionId: null, text: '' })

    const target = contents()
    const gate = new QuestionCoordinator(() => target)
    const controller = new AbortController()
    const asked = gate.ask({
      runId: 'r', sessionId: 's', question: 'Mana?', options: [{ id: 'a', label: 'A' }], allowCustom: false, signal: controller.signal
    })
    controller.abort()
    await expect(asked).resolves.toMatchObject({ optionId: null, text: '' })
  })
})

describe('ask_question tool', () => {
  const base: ToolContext = { workspaceRoot: '/tmp', signal: new AbortController().signal, runId: 'r', sessionId: 's', delegate: async () => 'report' }

  it('requires at least two options', () => {
    expect(() => askQuestionTool.prepare({ question: 'Mana?', options: [{ label: 'Satu' }] })).toThrow()
  })

  it('rejects duplicate option ids', async () => {
    setQuestionGateway(async () => ({ requestId: 'q', optionId: 'a', text: '' }))
    try {
      const prepared = askQuestionTool.prepare({ question: 'Mana?', options: [{ id: 'x', label: 'A' }, { id: 'x', label: 'B' }] })
      await expect(prepared.execute(base)).rejects.toThrow(/Duplicate option id/)
    } finally {
      setQuestionGateway(async () => ({ requestId: '', optionId: null, text: '' }))
    }
  })

  it('returns the clicked option label to the model', async () => {
    setQuestionGateway(async () => ({ requestId: 'q', optionId: 'b', text: '' }))
    try {
      const prepared = askQuestionTool.prepare({ question: 'Mana?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })
      const output = await prepared.execute(base)
      expect(output.text).toBe('The user chose "B".')
    } finally {
      setQuestionGateway(async () => ({ requestId: '', optionId: null, text: '' }))
    }
  })

  it('returns custom answers verbatim', async () => {
    setQuestionGateway(async () => ({ requestId: 'q', optionId: null, text: 'terserah' }))
    try {
      const prepared = askQuestionTool.prepare({ question: 'Mana?', options: [{ label: 'A' }, { label: 'B' }] })
      const output = await prepared.execute(base)
      expect(output.text).toBe('The user\'s custom answer: "terserah"')
    } finally {
      setQuestionGateway(async () => ({ requestId: '', optionId: null, text: '' }))
    }
  })

  it('tells a sub-agent to decide on its own', async () => {
    const subagent: ToolContext = { workspaceRoot: '/tmp', signal: new AbortController().signal }
    const prepared = askQuestionTool.prepare({ question: 'Mana?', options: [{ label: 'A' }, { label: 'B' }] })
    const output = await prepared.execute(subagent)
    expect(output.text).toMatch(/best judgement/)
  })

  it('stays out of the sub-agent kit', async () => {
    const { subagentTools } = await import('./tools/index')
    expect(subagentTools().some((tool) => tool.name === 'ask_question')).toBe(false)
  })
})
