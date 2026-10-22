/** Conservative offline defaults; limited-time promotions come only from the live feed. */
export const CLINE_FREE_FALLBACK = [
  'nvidia/nemotron-3.5-lightning:free',
  'reflection/beam-free',
  'openrouter/free'
] as const

/** Explicit free routes only; a similarly named paid model is never substituted. */
export function isExplicitClineFreeModel(id: string): boolean {
  return id.startsWith('cline-free/') || id.endsWith(':free') || id.endsWith('-free') || id === 'openrouter/free'
}

/** Prefer a public free route only when the account catalogue advertises it. */
export function preferredClineFreeRoute(model: string, available: readonly string[]): string {
  const equivalents: Record<string, string> = {
    'cline-free/minimax-m3.1-flash': 'minimax/minimax-m3.1-flash:free',
    'cline-free/nemotron-3.5-super-vl': 'nvidia/nemotron-3.5-super-vl:free'
  }
  const route = equivalents[model]
  return route && available.includes(route) ? route : model
}
