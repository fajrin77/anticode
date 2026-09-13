// Kept apart from rotation.ts, which reaches Electron through settings, so the
// agent loop can tell a spent quota apart without importing the app.

/**
 * Spent credit and exhausted plans, as opposed to a per-minute rate limit:
 * 402 Payment Required, or the words providers use for it — OpenAI's
 * insufficient_quota, Moonshot's exceeded_current_quota, Anthropic's credit
 * balance, OpenRouter's and DeepSeek's insufficient credits or balance, Z.ai's
 * usage limit. A plain "rate limit reached" is not one: that passes in a minute.
 */
const SPENT =
  /insufficient[_ -]?(quota|credits?|balance|funds)|exceeded[_ ](your[_ ])?(current[_ ])?quota|quota[_ ](exceeded|exhausted)|out of (credits?|quota|tokens)|credit balance|no credits? (left|remaining)|usage limit|billing|余额不足|额度/i

export function isOutOfUsage(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const record = error as { status?: unknown; code?: unknown; type?: unknown; message?: unknown; error?: unknown }
  if (record.status === 402) return true
  const inner = (record.error ?? null) as { code?: unknown; type?: unknown; message?: unknown } | null
  const said = [record.code, record.type, record.message, inner?.code, inner?.type, inner?.message]
    .filter((part) => typeof part === 'string' || typeof part === 'number')
    .join(' ')
  return SPENT.test(said)
}
