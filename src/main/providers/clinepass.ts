import { builtinOverride, checkedBaseURL, cleanModelIds, setBuiltinOverride } from './custom'
import type { ProviderEdit } from './custom'

/**
 * Clinepass subscription models do not appear in GET /models, so the catalogue
 * is fixed instead of fetched. Ids use the gateway's `cline-pass/` prefix.
 * Settings can replace the list when the subscription changes.
 */
export const CLINEPASS_MODELS: string[] = [
  'cline-pass/glm-5.3-flash',
  'cline-pass/deepseek-v4-flash',
  'cline-pass/deepseek-v4-pro',
  'cline-pass/kimi-k2.7-code',
  'cline-pass/kimi-k3',
  'cline-pass/mimo-v2.5',
  'cline-pass/minimax-m3',
  'cline-pass/qwen-3.8-max'
]

function env(name: string): string | null {
  const value = process.env[name]?.trim()
  return value !== undefined && value !== '' ? value : null
}

export interface ClinepassConfig {
  label: string
  apiKey: string | null
  baseURL: string | null
  models: string[]
  /** The ids were typed in Settings rather than shipped. */
  modelsEdited: boolean
  removed: boolean
}

/** The env file supplies Clinepass; whatever Settings changed wins over it. */
export function clinepassConfig(): ClinepassConfig {
  const override = builtinOverride('clinepass')
  const edited = Array.isArray(override.models) && override.models.length > 0
  return {
    label: override.label?.trim() || 'Clinepass',
    apiKey: override.apiKey?.trim() || env('CLINEPASS_API_KEY'),
    baseURL: override.baseURL?.trim() || env('CLINEPASS_BASE_URL'),
    models: edited ? (override.models ?? []) : CLINEPASS_MODELS,
    modelsEdited: edited,
    removed: override.removed === true
  }
}

/** Blank fields keep what is there; an emptied model list goes back to the shipped one. */
export function editClinepass(edit: ProviderEdit): void {
  const override = builtinOverride('clinepass')
  setBuiltinOverride('clinepass', {
    ...override,
    ...(edit.label?.trim() ? { label: edit.label.trim() } : {}),
    ...(edit.baseURL?.trim() ? { baseURL: checkedBaseURL(edit.baseURL) } : {}),
    ...(edit.apiKey?.trim() ? { apiKey: edit.apiKey.trim() } : {}),
    ...(edit.models !== undefined ? { models: cleanModelIds(edit.models) } : {})
  })
}

/**
 * Takes Clinepass out of every list and forgets what Settings saved for it.
 * A key in the env file is left alone — that file is the user's — so a
 * restore picks it back up.
 */
export function removeClinepass(): void {
  setBuiltinOverride('clinepass', { removed: true })
}

export function restoreClinepass(edit: ProviderEdit): void {
  setBuiltinOverride('clinepass', {})
  editClinepass(edit)
}
