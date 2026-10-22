/** Direct connections. Free routes keep their model ids and never fall back to paid aliases. */
const PRESETS = [
  { id: 'opencode-free', label: 'OpenCode Free', baseURL: 'https://opencode.ai/zen/v1', website: 'https://opencode.ai/auth', freeOnly: true, requiresKey: true, models: ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'minimax-m3.1-flash-free'], hint: 'Free routes only; separate from Go. OpenCode may restrict access to its official clients.' },
  { id: 'openrouter-free', label: 'OpenRouter Free', baseURL: 'https://openrouter.ai/api/v1', website: 'https://openrouter.ai/settings/keys', freeOnly: true, requiresKey: true, models: ['openrouter/free'], hint: 'Only :free model routes and the free router. Account rate limits apply.' },
  { id: 'kilo-free', label: 'Kilo Gateway Free', baseURL: 'https://ai-gateway.kilo.ai/api/v1', website: 'https://app.kilo.ai', freeOnly: true, requiresKey: false, models: [], hint: 'Only :free routes. API key optional; anonymous access has IP rate limits.' },
] as const

export const VERCEL_FREE_PRESET = {
  id: 'vercel-free',
  label: 'Vercel AI Gateway Free',
  baseURL: 'https://ai-gateway.vercel.sh/v1',
  website: 'https://vercel.com/ai-gateway',
  freeOnly: true,
  requiresKey: true,
  models: [],
  hint: 'Only :free routes on the Vercel AI Gateway. A gateway key is required.'
}
/** Account routes handled via a pasted key, so they are not custom endpoints. */
export const PRESET_VIEW = [...PRESETS, VERCEL_FREE_PRESET]
export type ProviderPresetId = 'opencode-free' | 'openrouter-free' | 'kilo-free' | 'vercel-free'

export function providerPreset(id: unknown): (typeof PRESET_VIEW)[number] | undefined {
  return PRESET_VIEW.find(preset => preset.id === id)
}

export function presetAllowsModel(id: ProviderPresetId, model: string): boolean {
  // Only documented Chat Completions routes. A free Responses/SystemOne model
  // must not be sent through this adapter just because its name ends in -free.
  if (id === 'opencode-free') return ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'minimax-m3.1-flash-free', 'beam-free', 'll-alpha-free', 'longcat-2.5-preview-free', 'exo-free', 'mimo-v2.6-flash-free', 'mimo-v2.5-free', 'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'nemotron-3.5-super-vl-free'].includes(model)
  return model.endsWith(':free') || (id === 'openrouter-free' && model === 'openrouter/free')
}
