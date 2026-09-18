import { z } from 'zod'
import { defineTool, ToolError } from './types'

/**
 * Hands one self-contained question to a sub-agent with a fresh context of its
 * own. Only its final report comes back, so the files it read never crowd the
 * parent's context. It counts as read-only: several in one turn run at once,
 * which is what makes exploring a big project in parallel possible.
 */
export const taskTool = defineTool({
  name: 'task',
  description:
    'Delegate a self-contained, read-only investigation to a sub-agent. It starts with a fresh context and ' +
    'can read files, list folders, search the workspace, read Excel/Word/PDF, and fetch URLs, but cannot ' +
    'edit, run commands, or ask the user. Only its final report returns to you. Give it everything it needs ' +
    'in the prompt and say what the report should contain. Issue several task calls in one turn to explore ' +
    'independent questions in parallel. Prefer it for broad searches across many files.',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    description: z.string().min(1).max(80).describe('A short label for the task, 3-8 words'),
    prompt: z.string().min(1).max(20_000).describe('The full, self-contained instructions for the sub-agent')
  }),
  execute: async (input, context) => {
    if (context.delegate === undefined) throw new ToolError('Sub-agents are not available in this context')
    return context.delegate({ description: input.description, prompt: input.prompt })
  }
})
