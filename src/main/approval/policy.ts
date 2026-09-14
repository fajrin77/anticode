import type { RiskTier } from '@shared/ipc'

/**
 * Commands that can destroy data, escalate privilege, or publish outward.
 * This is a heuristic, not a security boundary: a match forces per-call approval,
 * while a miss still leaves the call at medium risk, which is approved at least
 * once. It must never be treated as proof that a command is safe.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\bsudo\b/,
  /\bdoas\b/,
  /\brm\s+(-\w*\s+)*-\w*[rf]/,
  /\brmdir\s+/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^|]*\bof=/,
  /\bshutdown\b|\breboot\b|\bhalt\b/,
  /\bkillall\b|\bpkill\b/,
  /\bchmod\s+(-\w+\s+)*777\b/,
  /\bchown\s+-R\b/,
  /:\(\)\s*\{.*\}\s*;\s*:/,
  /\bgit\s+push\b[^&|;]*\s(--force\b|-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b[^&|;]*-\w*f/,
  /\bnpm\s+publish\b/,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|d)?sh\b/,
  />\s*\/dev\/(sd|nvme|disk)/
]

export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))
}

export class ApprovalPolicy {
  private autoApprove = false
  private readonly alwaysAllowed = new Set<string>()

  setAutoApprove(enabled: boolean): void {
    this.autoApprove = enabled
  }

  isAutoApprove(): boolean {
    return this.autoApprove
  }

  allowAlways(toolName: string, sessionId = 'default'): void {
    this.alwaysAllowed.add(`${sessionId}:${toolName}`)
  }

  /** The remembered grants, for persistence across restarts. */
  allowedAlways(): string[] {
    return [...this.alwaysAllowed]
  }

  restoreAlways(entries: string[]): void {
    for (const entry of entries) this.alwaysAllowed.add(entry)
  }

  /**
   * Auto mode covers every tier except high: destructive commands still ask,
   * because the point of Auto is fewer clicks, not silent `rm -rf`. Without
   * auto, low runs free, high always asks, and "always allow" lifts a single
   * tool to low — high included, since the grant was given knowingly.
   */
  needsApproval(toolName: string, risk: RiskTier, sessionId = 'default'): boolean {
    if (risk === 'low') return false
    if (this.autoApprove) return risk === 'high'
    if (risk === 'high') return !this.alwaysAllowed.has(`${sessionId}:${toolName}`)
    return !this.alwaysAllowed.has(`${sessionId}:${toolName}`)
  }
}
