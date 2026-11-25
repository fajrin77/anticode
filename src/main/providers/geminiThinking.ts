import type { EffortLevel } from '@shared/effort'

const LEVELS: Partial<Record<EffortLevel, 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH'>> = {
  minimal: 'MINIMAL',
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH'
}

/** Gemini 3 and later take a thinking level; nothing is sent when the user kept the default. */
export function thinkingConfig(effort: EffortLevel | undefined): { thinkingConfig?: { thinkingLevel: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' } } {
  const level = effort === undefined ? undefined : LEVELS[effort]
  return level === undefined ? {} : { thinkingConfig: { thinkingLevel: level } }
}
