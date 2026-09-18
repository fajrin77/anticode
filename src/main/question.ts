import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { QuestionAnswer, QuestionRequest } from '@shared/ipc'

export interface AskInput {
  runId: string
  sessionId: string
  question: string
  options: { id: string; label: string; hint?: string }[]
  allowCustom: boolean
  signal: AbortSignal
}

/**
 * The agent's questions wait for a clicked answer the way approvals wait for
 * a decision: one modal at a time per window, phone included. A closed window
 * or a cancelled run settles to "unanswered" so the run proceeds on its own
 * judgement instead of hanging forever.
 */
export class QuestionCoordinator {
  private readonly requests = new Map<string, QuestionRequest>()
  private readonly pending = new Map<string, (answer: QuestionAnswer) => void>()

  constructor(
    private readonly sender: () => WebContents | null,
    private readonly onDismissed?: (requestId: string) => void,
    private readonly onRequested?: (request: QuestionRequest) => void
  ) {}

  listPending(): QuestionRequest[] { return [...this.requests.values()] }

  resolve(requestId: string, answer: Omit<QuestionAnswer, 'requestId'>): void {
    this.pending.get(requestId)?.({ ...answer, requestId })
  }

  async ask(input: AskInput): Promise<QuestionAnswer> {
    if (input.signal.aborted) return { requestId: '', optionId: null, text: '' }
    const target = this.sender()
    const payload: QuestionRequest = {
      requestId: randomUUID(),
      runId: input.runId,
      sessionId: input.sessionId,
      question: input.question,
      options: input.options,
      allowCustom: input.allowCustom
    }
    this.onRequested?.(payload)
    return this.awaitAnswer(payload, target, input.signal)
  }

  private awaitAnswer(
    payload: QuestionRequest,
    target: WebContents | null,
    signal: AbortSignal
  ): Promise<QuestionAnswer> {
    const unanswered = (requestId: string): QuestionAnswer => ({ requestId, optionId: null, text: '' })
    if (signal.aborted || target === null || target.isDestroyed()) {
      return Promise.resolve(unanswered(payload.requestId))
    }

    return new Promise((resolve) => {
      const onDestroyed = (): void => settle(unanswered(payload.requestId))
      const settle = (answer: QuestionAnswer): void => {
        this.pending.delete(payload.requestId)
        this.requests.delete(payload.requestId)
        this.onDismissed?.(payload.requestId)
        signal.removeEventListener('abort', onAbort)
        target?.off('destroyed', onDestroyed)
        resolve(answer)
      }
      const onAbort = (): void => settle(unanswered(payload.requestId))

      this.pending.set(payload.requestId, settle)
      this.requests.set(payload.requestId, payload)
      signal.addEventListener('abort', onAbort, { once: true })
      target?.once('destroyed', onDestroyed)
      target?.send(IpcChannel.QUESTION_REQUEST, payload)
    })
  }
}
