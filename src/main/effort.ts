import { isEffortLevel, ruleEffort, validModelEffort } from '@shared/effort'
import type { EffortFamily, EffortLevel, ModelEffort } from '@shared/effort'
import { loadPersistedSettings, savePersistedSettings } from './settings'

/**
 * The level picked for each model, by model id. It is a property of the model
 * and not of the account, so a model keeps its level when Rotate moves the
 * session to another login of the same vendor.
 */
export function chosenEfforts(): Record<string, EffortLevel> {
  const saved = loadPersistedSettings().effortByModel ?? {}
  return Object.fromEntries(Object.entries(saved).filter(([, level]) => isEffortLevel(level))) as Record<string, EffortLevel>
}

export function setModelEffort(model: unknown, level: unknown): void {
  if (typeof model !== 'string' || model.trim() === '' || model.length > 200) throw new Error('Choose a model first')
  if (level !== null && !isEffortLevel(level)) throw new Error('Unknown effort level')
  const next = { ...chosenEfforts() }
  if (level === null) delete next[model]
  else next[model] = level
  savePersistedSettings({ effortByModel: next })
}

/** What any connected account reported for this model; one report is enough. */
function reported(model: string): ModelEffort | null {
  for (const catalogue of Object.values(loadPersistedSettings().authModelCatalogues ?? {})) {
    const found = validModelEffort(catalogue.efforts?.[model])
    if (found !== null) return found
  }
  return null
}

/**
 * The level to send with a request, or undefined to send nothing and let the
 * provider use its own default. A level the model does not accept (picked for
 * an earlier version of it, say) is dropped instead of failing the request.
 */
export function requestEffort(family: EffortFamily, model: string): EffortLevel | undefined {
  const chosen = chosenEfforts()[model]
  if (chosen === undefined) return undefined
  const levels = (reported(model) ?? ruleEffort(family, model))?.levels ?? []
  return levels.includes(chosen) ? chosen : undefined
}

/** Claude's request field has no `none` or `minimal`; a level outside its set is not sent. */
export function claudeEffort(level: EffortLevel | undefined): Exclude<EffortLevel, 'none' | 'minimal'> | undefined {
  return level === 'none' || level === 'minimal' ? undefined : level
}

/** Codex `/models` entries name their own levels; keep them beside the model ids. */
export function parseCodexEfforts(value: unknown): Record<string, ModelEffort> {
  const raw = value as { models?: unknown; data?: unknown } | null
  const entries = raw?.models ?? raw?.data
  if (!Array.isArray(entries)) return {}
  const found: Record<string, ModelEffort> = {}
  for (const item of entries) {
    const entry = item as { slug?: unknown; id?: unknown; supported_reasoning_levels?: unknown; default_reasoning_level?: unknown } | null
    const id = entry?.slug ?? entry?.id
    if (typeof id !== 'string' || !Array.isArray(entry?.supported_reasoning_levels)) continue
    const levels = entry.supported_reasoning_levels.map((level: unknown) =>
      typeof level === 'string' ? level : (level as { effort?: unknown } | null)?.effort)
    const effort = validModelEffort({ levels, default: entry.default_reasoning_level })
    if (effort !== null) found[id] = effort
  }
  return found
}

/** Anthropic `/v1/models` entries carry `capabilities.effort` with one flag per level. */
export function parseClaudeEffort(entry: unknown): ModelEffort | null {
  const effort = (entry as { capabilities?: { effort?: Record<string, unknown> | null } } | null)?.capabilities?.effort
  if (effort === null || effort === undefined || effort['supported'] !== true) return null
  const levels = Object.entries(effort).flatMap(([level, flag]) =>
    isEffortLevel(level) && (flag as { supported?: unknown } | null)?.supported === true ? [level] : [])
  // The Messages API runs at high when no level is sent.
  return validModelEffort({ levels, default: 'high' })
}
