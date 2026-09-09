import type { RiskTier, ToolPreview } from '@shared/ipc'

export interface AuthorizeRequest {
  runId: string
  toolName: string
  risk: RiskTier
  /** Computed only when approval is actually needed, so auto-approved calls stay cheap. */
  preview: () => Promise<ToolPreview>
  signal: AbortSignal
}

export interface ApprovalGate {
  authorize: (request: AuthorizeRequest) => Promise<boolean>
}

/** Used by tests and by any path where the policy layer is not involved. */
export const allowAll: ApprovalGate = {
  authorize: async () => true
}
