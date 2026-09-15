import { expect, it } from 'vitest'
import { latestPlan } from './TodoPanel'
import type { Message } from '../store/session'

const call = (id: string, items: unknown, status: 'ok' | 'error' | 'running' = 'ok'): Message => ({
  id,
  role: 'assistant',
  pending: false,
  parts: [{ kind: 'tool', toolUseId: id, name: 'todo_write', input: { items }, status, output: '' }]
})

it('takes the newest checklist that went through', () => {
  const first = [{ content: 'Inspect', status: 'in_progress' }]
  const second = [{ content: 'Inspect', status: 'completed' }, { content: 'Fix', status: 'in_progress' }]
  expect(latestPlan([call('a', first), call('b', second)])).toEqual(second)
  // A refused call replaced nothing.
  expect(latestPlan([call('a', first), call('b', [{ content: 'x', status: 'pending' }], 'error')])).toEqual(first)
  expect(latestPlan([])).toBeNull()
})

it('does not carry a previous run plan into a new prompt', () => {
  const old = [{ content: 'One', status: 'completed' }, { content: 'Two', status: 'pending' }, { content: 'Three', status: 'pending' }]
  const nextPrompt: Message = {
    id: 'next', role: 'user', pending: false, parts: [{ kind: 'text', text: 'new request' }]
  }
  expect(latestPlan([call('old', old), nextPrompt])).toBeNull()
})
