import { z } from 'zod'
import { defineTool } from './types'

const item = z.object({
  content: z.string().min(1).max(300).describe('A concrete task, written as an action'),
  status: z.enum(['pending', 'in_progress', 'completed'])
})

/** The result itself is the persisted ledger: it survives transcript reloads. */
export const todoWriteTool = defineTool({
  name: 'todo_write',
  description:
    'Publish the current task plan as a complete checklist. Replace the whole list on every call, ' +
    'keep exactly one item in_progress, and update it as work advances. Use for multi-step work.',
  readOnly: false,
  risk: 'low',
  schema: z.object({
    items: z.array(item).min(1).max(30).describe('The complete current checklist, in execution order')
  }),
  execute: async ({ items }) => {
    const active = items.filter((entry) => entry.status === 'in_progress').length
    if (active > 1) throw new Error('Only one todo may be in progress at a time')
    const mark = { pending: '[ ]', in_progress: '[>]', completed: '[x]' } as const
    return ['Task plan:', ...items.map((entry) => `${mark[entry.status]} ${entry.content}`)].join('\n')
  }
})
