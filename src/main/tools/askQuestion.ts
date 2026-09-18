import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { askUserQuestion } from '../question-gateway'

const optionSchema = z.object({
  id: z.string().min(1).max(40).optional(),
  label: z.string().min(1).max(120),
  hint: z.string().max(200).optional()
})

/**
 * The one tool that talks back to the user mid-run: the question pops up with
 * clickable options and the run waits for the click. For genuine forks only,
 * a preference the work cannot proceed without, never for status updates.
 */
export const askQuestionTool = defineTool({
  name: 'ask_question',
  description:
    'Ask the user a question when their preference genuinely blocks the work. ' +
    'The question pops up with clickable options; the run waits for the click. ' +
    'Use for real forks (which approach, which scope, which destination), 2-4 ' +
    'options with short labels and one-line hints. Do not use for progress ' +
    'reports, confirmations of what you already decided, or anything you can ' +
    'read from the files. If the user does not answer, proceed with your best ' +
    'judgement and say what you assumed.',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    question: z.string().min(1).max(500).describe('The question, one sentence'),
    options: z
      .array(optionSchema)
      .min(2)
      .max(4)
      .describe('2-4 clickable answers, each with a short label and an optional one-line hint'),
    allow_custom: z
      .boolean()
      .default(true)
      .describe('Whether a custom typed answer is accepted alongside the options')
  }),
  preview: async (input) => ({
    kind: 'text',
    subject: 'ask_question',
    detail: `${input.question}\n${input.options.map((option) => `- ${option.label}`).join('\n')}`
  }),
  execute: async (input, context) => {
    // A sub-agent has no window to click in; it must decide on its own.
    if (context.delegate === undefined) {
      return 'The question cannot be asked here. Proceed with your best judgement and say what you assumed.'
    }
    const options = input.options.map((option, index) => ({
      id: option.id ?? `option-${index + 1}`,
      label: option.label,
      ...(option.hint !== undefined ? { hint: option.hint } : {})
    }))
    const seen = new Set<string>()
    for (const option of options) {
      if (seen.has(option.id)) throw new ToolError(`Duplicate option id "${option.id}". Give each option its own id.`)
      seen.add(option.id)
    }
    const answer = await askUserQuestion({
      runId: context.runId ?? '',
      sessionId: context.sessionId ?? '',
      question: input.question,
      options,
      allowCustom: input.allow_custom,
      signal: context.signal
    })
    if (answer.optionId === null && answer.text === '') {
      return 'The user did not answer. Proceed with your best judgement and say what you assumed.'
    }
    if (answer.optionId !== null) {
      const picked = options.find((option) => option.id === answer.optionId)
      const label = picked?.label ?? answer.optionId
      const hint = picked?.hint !== undefined ? ` (${picked.hint})` : ''
      return `The user chose "${label}"${hint}.`
    }
    return `The user's custom answer: "${answer.text}"`
  }
})
