import type { QuestionAnswer } from '@shared/ipc'
import type { AskInput } from './question'

type Gateway = (input: AskInput) => Promise<QuestionAnswer>

let gateway: Gateway | null = null

/** Wired once from the IPC layer, where the question coordinator lives. */
export function setQuestionGateway(next: Gateway): void {
  gateway = next
}

/** Resolves unanswered when no window can ask (tests, headless runs). */
export function askUserQuestion(input: AskInput): Promise<QuestionAnswer> {
  if (gateway === null) return Promise.resolve({ requestId: '', optionId: null, text: '' })
  return gateway(input)
}
