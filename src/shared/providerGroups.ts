import type { AuthKind, ProviderInfo } from './ipc'
import { DIRECT_AUTH_LABELS } from './directAuthProviders'
const labels: Record<AuthKind, string> = { ...DIRECT_AUTH_LABELS, cursor: 'Cursor', antigravity: 'Antigravity', copilot: 'GitHub Copilot', codex: 'ChatGPT (Codex)', cline: 'Cline Free', clinepass: 'ClinePass', claude: 'Claude Code', codebuddy: 'CodeBuddy', 'opencode-go': 'OpenCode Go', kilo: 'Kilo Free', openrouter: 'OpenRouter Free', vercel: 'Vercel AI Gateway', 'minimax-plan': 'MiniMax Token Plan' }

/** Account identity stays intact; only the model-selection UI is grouped. */
export function groupAuthProviders(providers: ProviderInfo[]): ProviderInfo[] {
  const result: ProviderInfo[] = []
  const groups = new Map<AuthKind, ProviderInfo>()
  for (const provider of providers) {
    if (provider.kind !== 'auth' || !provider.authKind) { result.push(provider); continue }
    const existing = groups.get(provider.authKind)
    if (!existing) {
      const group = { ...provider, accountIds: [provider.id] }
      groups.set(provider.authKind, group)
      result.push(group)
    } else {
      existing.accountIds!.push(provider.id)
      existing.models = [...new Set([...(existing.models ?? []), ...(provider.models ?? [])])]
      existing.composerVisible ||= provider.composerVisible === true
      existing.credentialAvailable ||= provider.credentialAvailable
    }
  }
  for (const [kind, group] of groups) group.label = group.accountIds!.length > 1 ? `${labels[kind]} · ${group.accountIds!.length} accounts` : labels[kind]
  return result
}
