/**
 * Reasoning effort: how long a model thinks before it answers. Every vendor
 * spells it differently (Claude `effort`, OpenAI `reasoning.effort`, Gemini
 * `thinkingLevel`) and every model offers a different set of levels, so the
 * composer only ever shows the levels the model in use accepts.
 */
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

/** The API that carries the level; it decides the request field, not the levels. */
export type EffortFamily = 'claude' | 'openai' | 'gemini'

export interface ModelEffort {
  /** Ordered from least to most thinking. */
  levels: EffortLevel[]
  /** What the provider runs when no level is sent. */
  default: EffortLevel
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function orderedLevels(levels: Iterable<unknown>): EffortLevel[] {
  const wanted = new Set([...levels].filter(isEffortLevel))
  return EFFORT_LEVELS.filter((level) => wanted.has(level))
}

/** A catalogue entry is only trusted when it names at least two levels and its default is one of them. */
export function validModelEffort(value: unknown): ModelEffort | null {
  const entry = value as { levels?: unknown; default?: unknown } | null
  if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.levels)) return null
  const levels = orderedLevels(entry.levels)
  if (levels.length < 2) return null
  const fallback = levels.includes('medium') ? 'medium' : levels[Math.floor(levels.length / 2)]!
  return { levels, default: isEffortLevel(entry.default) && levels.includes(entry.default) ? entry.default : fallback }
}

/** Vendor prefixes used by gateways (`openai/gpt-5`) do not change what the model accepts. */
function bare(model: string): string {
  return model.toLowerCase().split('/').at(-1) ?? ''
}

/**
 * Levels a model is known to accept when its account's catalogue did not say.
 * Conservative on purpose: a level the model rejects fails the whole request.
 */
export function ruleEffort(family: EffortFamily, model: string): ModelEffort | null {
  const id = bare(model)
  if (family === 'claude') {
    const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id)
    if (match === null) return null
    const [, tier = '', majorText = '0', minorText] = match
    const major = Number(majorText)
    const minor = minorText === undefined ? 0 : Number(minorText)
    const at = major * 100 + minor
    if (tier === 'haiku') return major >= 5 ? { levels: ['low', 'medium', 'high'], default: 'high' } : null
    if (at < 405) return null
    if (at === 405) return tier === 'opus' ? { levels: ['low', 'medium', 'high'], default: 'high' } : null
    if (at === 406) return { levels: ['low', 'medium', 'high', 'max'], default: 'high' }
    return { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' }
  }
  if (family === 'openai') {
    if (/^o\d/.test(id) || id.includes('codex-mini')) return { levels: ['low', 'medium', 'high'], default: 'medium' }
    const match = /^gpt-(\d+)(?:\.(\d+))?/.exec(id)
    if (match === null) return null
    const version = Number(match[1]) * 100 + Number(match[2] ?? 0)
    // gpt-5-chat and the like are plain chat models with no reasoning knob.
    if (version < 500 || /-chat(?:-|$)/.test(id)) return null
    return version >= 502 || id.includes('codex-max')
      ? { levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' }
      : { levels: ['low', 'medium', 'high'], default: 'medium' }
  }
  const match = /^gemini-(\d+)(?:\.(\d+))?/.exec(id)
  if (match === null || Number(match[1]) < 3 || id.includes('image') || id.includes('tts')) return null
  return { levels: ['low', 'high'], default: 'high' }
}

/** The family a provider entry speaks for a model, or null when it has no effort knob. */
export function effortFamily(
  provider: { id: string; kind?: string; authKind?: string } | undefined,
  model: string
): EffortFamily | null {
  if (provider === undefined || model === '') return null
  const id = bare(model)
  const auth = provider.authKind
  if (auth === 'claude') return id.startsWith('claude-') ? 'claude' : null
  if (auth === 'codex') return 'openai'
  if (auth === 'gemini') return id.startsWith('gemini-') ? 'gemini' : null
  if (auth === 'antigravity') return id.startsWith('gemini-') ? 'gemini' : null
  if (auth !== undefined) return null
  if (provider.id === 'anthropic' || provider.kind === 'anthropic') return id.startsWith('claude-') ? 'claude' : null
  if (provider.id === 'openai' || provider.kind === 'openai-api') return 'openai'
  if (provider.id === 'google') return id.startsWith('gemini-') ? 'gemini' : null
  return null
}

/** Levels for this provider and model: the account's own report first, then the known rules. */
export function modelEffort(
  provider: { id: string; kind?: string; authKind?: string; efforts?: Record<string, ModelEffort> } | undefined,
  model: string
): ModelEffort | null {
  const family = effortFamily(provider, model)
  if (family === null) return null
  return validModelEffort(provider?.efforts?.[model]) ?? ruleEffort(family, model)
}
