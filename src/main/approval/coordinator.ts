import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { ApprovalDecision, ApprovalRequest } from '@shared/ipc'
import type { ApprovalGate, AuthorizeRequest } from './types'
import type { ApprovalPolicy } from './policy'

export class ApprovalCoordinator implements ApprovalGate {
  private readonly pending = new Map<string, (decision: ApprovalDecision) => void>()

  constructor(
    private readonly policy: ApprovalPolicy,
    private readonly sender: () => WebContents | null
  ) {}

  resolve(requestId: string, decision: ApprovalDecision): void {
    this.pending.get(requestId)?.(decision)
  }

  async authorize(request: AuthorizeRequest): Promise<boolean> {
    if (!this.policy.needsApproval(request.toolName, request.risk)) return true

    const target = this.sender()
    if (!target || target.isDestroyed()) return false

    // §8: a high-risk call must be approved individually every single time.
    const allowAlways = request.risk !== 'high'
    const payload: ApprovalRequest = {
      requestId: randomUUID(),
      runId: request.runId,
      toolName: request.toolName,
      risk: request.risk,
      preview: await request.preview(),
      allowAlways
    }

    const decision = await this.awaitDecision(payload, target, request.signal)
    if (decision === 'always' && allowAlways) this.policy.allowAlways(request.toolName)
    return decision !== 'reject'
  }

  private awaitDecision(
    payload: ApprovalRequest,
    target: WebContents,
    signal: AbortSignal
  ): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const settle = (decision: ApprovalDecision): void => {
        this.pending.delete(payload.requestId)
        signal.removeEventListener('abort', onAbort)
        resolve(decision)
      }
      const onAbort = (): void => settle('reject')

      if (signal.aborted) {
        resolve('reject')
        return
      }

      this.pending.set(payload.requestId, settle)
      signal.addEventListener('abort', onAbort, { once: true })
      target.send(IpcChannel.APPROVAL_REQUEST, payload)
    })
  }
}
