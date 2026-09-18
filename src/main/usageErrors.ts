// Kept apart from rotation.ts, which reaches Electron through settings, so the
// agent loop can tell a spent quota apart without importing the app.

/**
 * Spent credit and exhausted plans, as opposed to a per-minute rate limit:
 * 402 Payment Required, or the words providers use for it, OpenAI's
 * insufficient_quota, Moonshot's exceeded_current_quota, Anthropic's credit
 * balance, OpenRouter's and DeepSeek's insufficient credits or balance, Z.ai's
 * usage limit. A plain "rate limit reached" is not one: that passes in a minute.
 */
const SPENT =
  /insufficient[_ -]?(quota|credits?|balance|funds)|exceeded[_ ](your[_ ])?(current[_ ])?quota|quota[_ ](exceeded|exhausted)|out of (credits?|quota|tokens)|credit balance|no credits? (left|remaining)|(?:reached|exceeded) your (?:monthly )?[^\n.]{0,40}limit|usage limit|spend(?:ing)? limit|payment required|余额不足|额度/i

export function isOutOfUsage(error: unknown): boolean {
  let current: unknown = error
  const said: Array<string | number> = []

  // SDKs wrap the provider response differently (`error`, `cause`, or both),
  // so inspect a few layers instead of coupling this to one provider/client.
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const record = current as {
      status?: unknown
      statusCode?: unknown
      code?: unknown
      type?: unknown
      message?: unknown
      error?: unknown
      cause?: unknown
    }
    if (record.status === 402 || record.statusCode === 402) return true
    for (const part of [record.code, record.type, record.message]) {
      if (typeof part === 'string' || typeof part === 'number') said.push(part)
    }
    current = record.error ?? record.cause
  }

  return SPENT.test(said.join(' '))
}
