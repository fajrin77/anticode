import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { ApprovalDecision, ApprovalRequest } from '@shared/ipc'
import type { ApprovalGate, AuthorizeRequest } from './types'
import type { ApprovalPolicy } from './policy'

export class ApprovalCoordinator implements ApprovalGate {
  private readonly requests = new Map<string, ApprovalRequest>()
  listPending(): ApprovalRequest[] { return [...this.requests.values()] }
  private readonly pending = new Map<string, (decision: ApprovalDecision) => void>()

  constructor(
    private readonly policy: ApprovalPolicy,
    private readonly sender: () => WebContents | null,
    private readonly onDismissed?: (requestId: string) => void,
    private readonly onRequested?: (request: ApprovalRequest) => void,
    /** Fires when "Always allow" adds a grant, so the caller can persist it. */
    private readonly onAlways?: (grants: string[]) => void
  ) {}

  resolve(requestId: string, decision: ApprovalDecision): void {
    this.pending.get(requestId)?.(decision)
  }

  async authorize(request: AuthorizeRequest): Promise<boolean> {
    if (request.signal.aborted) return false
    if (!this.policy.needsApproval(request.toolName, request.risk, request.sessionId)) return true

    const target = this.sender()

    // In Default mode, a high-risk decision applies only to this call.
    const allowAlways = request.risk !== 'high'
    const payload: ApprovalRequest = {
      requestId: randomUUID(),
      runId: request.runId,
      toolName: request.toolName,
      risk: request.risk,
      preview: await request.preview(),
      allowAlways
    }

    this.onRequested?.(payload)

    const decision = await this.awaitDecision(payload, target, request.signal)
    if (decision === 'always' && allowAlways) {
      this.policy.allowAlways(request.toolName, request.sessionId)
      this.onAlways?.(this.policy.allowedAlways())
    }
    return decision !== 'reject'
  }

  private awaitDecision(
    payload: ApprovalRequest,
    target: WebContents | null,
    signal: AbortSignal
  ): Promise<ApprovalDecision> {
    if (signal.aborted || target?.isDestroyed()) return Promise.resolve('reject')

    return new Promise((resolve) => {
      // A closed window must not leave the run waiting forever — on macOS the
      // app keeps living after its last window closes.
      const onDestroyed = (): void => settle('reject')
      const settle = (decision: ApprovalDecision): void => {
        this.pending.delete(payload.requestId)
        this.requests.delete(payload.requestId)
        this.onDismissed?.(payload.requestId)
        signal.removeEventListener('abort', onAbort)
        target?.off('destroyed', onDestroyed)
        resolve(decision)
      }
      const onAbort = (): void => settle('reject')

      this.pending.set(payload.requestId, settle)
      this.requests.set(payload.requestId, payload)
      signal.addEventListener('abort', onAbort, { once: true })
      target?.once('destroyed', onDestroyed)
      target?.send(IpcChannel.APPROVAL_REQUEST, payload)
    })
  }
}
