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
    private readonly onAlways?: (grants: string[]) => void,
    /** True when another viewer (remote phone) can answer while no desktop window is open. */
    private readonly hasAlternateViewer: () => boolean = () => false
  ) {}

  resolve(requestId: string, decision: ApprovalDecision): void {
    if (!['approve', 'reject', 'always'].includes(decision)) return
    if (decision === 'always' && this.requests.get(requestId)?.allowAlways !== true) return
    this.pending.get(requestId)?.(decision)
  }

  async authorize(request: AuthorizeRequest): Promise<boolean> {
    if (request.signal.aborted) return false
    if (!this.policy.needsApproval(request.toolName, request.risk, request.sessionId)) return true

    // In Default mode, a high-risk decision applies only to this call.
    const allowAlways = request.risk !== 'high'
    const preview = await request.preview()
    if (request.signal.aborted) return false

    const target = this.sender()
    if ((target === null || target.isDestroyed()) && !this.hasAlternateViewer()) return false

    const payload: ApprovalRequest = {
      requestId: randomUUID(),
      runId: request.runId,
      sessionId: request.sessionId,
      workspaceRoot: request.workspaceRoot ?? null,
      toolName: request.toolName,
      risk: request.risk,
      preview,
      allowAlways
    }

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
    if (signal.aborted) return Promise.resolve('reject')
    if ((target === null || target.isDestroyed()) && !this.hasAlternateViewer()) {
      return Promise.resolve('reject')
    }

    return new Promise((resolve) => {
      // A closed window must not leave the run waiting forever, on macOS the
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
      this.onRequested?.(payload)
    })
  }
}
