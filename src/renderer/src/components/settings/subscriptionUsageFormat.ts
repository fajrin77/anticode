export function quotaWindowLabel(label: string): string {
  return ({ Weekly: 'Weekly', Monthly: 'Monthly', '5-hour window': 'Session limit', '7-day window': 'Weekly · all models', 'Opus 7-day window': 'Weekly · Opus', 'Sonnet 7-day window': 'Weekly · Sonnet', 'OAuth apps 7-day window': 'Weekly · OAuth apps', 'Primary window': 'Primary limit', 'Secondary window': 'Secondary limit' } as Record<string, string>)[label] ?? label
}

export function quotaResetLabel(resetAt: number | null, now: number): string {
  if (resetAt === null || !Number.isFinite(resetAt)) return 'Reset time not available yet'
  const remaining = resetAt - now
  if (remaining <= 0) return 'Waiting for the quota to refresh'
  if (remaining < 24 * 60 * 60 * 1000) {
    const minutes = Math.ceil(remaining / 60000)
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return `Resets in ${hours ? `${hours} h${rest ? ' ' : ''}` : ''}${rest ? `${rest} min` : ''}`
  }
  if (remaining >= 7 * 24 * 60 * 60 * 1000) return `Resets ${new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(resetAt)}`
  return `Resets ${new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(resetAt)}`
}
