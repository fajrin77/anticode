import { builtinOverride, checkedBaseURL, cleanApiKeys, cleanModelIds, setBuiltinOverride, getCustomProvider, importLegacyProvider, updateCustomProvider, removeCustomProvider } from './custom'
import type { ProviderEdit } from './custom'

/** Clinepass plan ids use the case-sensitive `cline-pass/` prefix. */
export function canonicalClinepassModel(model: string): string {
  return model.toLowerCase() === 'cline-pass/muse-spark-1.3-contributor'
    ? 'cline-pass/muse-spark-1.3-contributor'
    : model
}

export const CLINEPASS_DIRECT_URL = 'https://api.cline.bot/api/v1'

export function isDirectClinepassURL(value: string | null): boolean {
  if (value === null) return false
  try {
    const url = new URL(value)
    return url.origin === 'https://api.cline.bot' && url.pathname.replace(/\/+$/, '') === '/api/v1' && !url.search && !url.hash && !url.username && !url.password
  } catch { return false }
}

export const CLINEPASS_MODELS: string[] = [
  'cline-pass/muse-spark-1.3-contributor',
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
  apiKeys: string[]
  apiKey: string | null
  baseURL: string | null
  models: string[]
  /** The ids were typed in Settings rather than shipped. */
  modelsEdited: boolean
  removed: boolean
}

/** The env file supplies Clinepass; whatever Settings changed wins over it. */
export function clinepassConfig(): ClinepassConfig {
  const custom = getCustomProvider('clinepass')
  if (custom) return { label: custom.label, apiKey: custom.apiKey || null, apiKeys: cleanApiKeys([custom.apiKey, ...(custom.apiKeys ?? [])]), baseURL: custom.baseURL, models: custom.models ?? [], modelsEdited: true, removed: false }
  const override = builtinOverride('clinepass')
  const edited = Array.isArray(override.models) && override.models.length > 0
  return {
    label: override.label?.trim() || 'Clinepass',
    apiKeys: cleanApiKeys([override.apiKey?.trim() || env('CLINEPASS_API_KEY') || '', ...(override.apiKeys ?? [])]),
    apiKey: override.apiKey?.trim() || env('CLINEPASS_API_KEY'),
    baseURL: override.baseURL?.trim() || env('CLINEPASS_BASE_URL') || CLINEPASS_DIRECT_URL,
    models: [...new Set((edited ? (override.models ?? []) : CLINEPASS_MODELS).map(canonicalClinepassModel))],
    modelsEdited: edited,
    removed: override.removed === true
  }
}

/** Compatibility only: a fresh profile never gets an automatic provider. */
export function migrateLegacyClinepass(): void {
  if (getCustomProvider('clinepass')) return
  const legacy = clinepassConfig()
  if (legacy.removed || !legacy.apiKey || !legacy.baseURL) return
  importLegacyProvider({ id: 'clinepass', label: legacy.label, kind: 'openai', baseURL: legacy.baseURL, apiKey: legacy.apiKey, apiKeys: legacy.apiKeys, models: legacy.models, billing: isDirectClinepassURL(legacy.baseURL) ? 'subscription' : 'unknown' })
}

/** Blank fields keep what is there; an emptied model list goes back to the shipped one. */
export function editClinepass(edit: ProviderEdit): void {
  if (getCustomProvider('clinepass')) {
    updateCustomProvider('clinepass', { ...edit, ...(edit.models !== undefined ? { models: edit.models.length ? cleanModelIds(edit.models.map(canonicalClinepassModel)) : CLINEPASS_MODELS } : {}) })
    return
  }
  const override = builtinOverride('clinepass')
  setBuiltinOverride('clinepass', {
    ...override,
    ...(edit.apiKeys || edit.apiKey?.trim() ? { apiKeys: cleanApiKeys([edit.apiKey?.trim() || override.apiKey || env('CLINEPASS_API_KEY') || '', ...(override.apiKeys ?? []).filter(key => key !== override.apiKey), ...(edit.apiKeys ?? [])]) } : {}),
    ...(edit.label?.trim() ? { label: edit.label.trim() } : {}),
    ...(edit.baseURL?.trim() ? { baseURL: checkedBaseURL(edit.baseURL) } : {}),
    ...(edit.apiKey?.trim() ? { apiKey: edit.apiKey.trim() } : {}),
    ...(edit.models !== undefined ? { models: cleanModelIds(edit.models.map(canonicalClinepassModel)) } : {})
  })
}

/**
 * Takes Clinepass out of every list and forgets what Settings saved for it.
 * A key in the env file is left alone, that file is the user's, so a
 * restore picks it back up.
 */
export function removeClinepass(): void {
  if (getCustomProvider('clinepass')) removeCustomProvider('clinepass')
  setBuiltinOverride('clinepass', { removed: true })
}

export function restoreClinepass(edit: ProviderEdit): void {
  setBuiltinOverride('clinepass', {})
  editClinepass(edit)
}
