/** Explicit key-based API routes, not subscription OAuth or guaranteed free tiers. */
export const DIRECT_AUTH_PROVIDERS = {
  'nvidia-nim': { label: 'NVIDIA NIM', baseURL: 'https://integrate.api.nvidia.com/v1', website: 'https://build.nvidia.com', hint: 'Direct API key. Trial credits and account limits apply.' },
  'ollama-cloud': { label: 'Ollama Cloud', baseURL: 'https://ollama.com/v1', website: 'https://ollama.com/settings/keys', hint: 'Direct cloud API key. Uses account cloud limits, not local Ollama.' },
  xai: { label: 'xAI (Grok)', baseURL: 'https://api.x.ai/v1', website: 'https://console.x.ai', hint: 'Metered API key, not Grok subscription or Grok CLI.' },
  'kimi-api': { label: 'Kimi API', baseURL: 'https://api.moonshot.ai/v1', website: 'https://platform.moonshot.ai', hint: 'Metered Moonshot API key, not Kimi Code subscription OAuth.' },
  'byteplus-api': { label: 'BytePlus ModelArk', baseURL: 'https://ark.ap-southeast.bytepluses.com/api/v3', website: 'https://console.byteplus.com/ark', hint: 'ModelArk API key. Account model access and billing apply.' },
  'kimchi-api': { label: 'Kimchi', baseURL: 'https://api.kimchillm.com/v1', website: 'https://www.kimchillm.com', hint: 'Direct API key. Account quota and pricing apply.' },
  'airforce-api': { label: 'API.airforce', baseURL: 'https://api.airforce/v1', website: 'https://api.airforce', hint: 'Direct API key. Provider limits and pricing apply.' },
  'bazaarlink-api': { label: 'Bazaarlink', baseURL: 'https://bazaarlink.ai/v1', website: 'https://bazaarlink.ai', hint: 'Direct API key. Account model access and pricing apply.' }
} as const
export type DirectAuthKind = keyof typeof DIRECT_AUTH_PROVIDERS
export function isDirectAuthKind(kind: string): kind is DirectAuthKind { return Object.hasOwn(DIRECT_AUTH_PROVIDERS, kind) }
export const DIRECT_AUTH_LABELS = Object.fromEntries(Object.entries(DIRECT_AUTH_PROVIDERS).map(([id, c]) => [id, c.label])) as Record<DirectAuthKind, string>
export const DIRECT_AUTH_MODELS = Object.fromEntries(Object.keys(DIRECT_AUTH_PROVIDERS).map((id) => [id, ['']])) as unknown as Record<DirectAuthKind, readonly [string, ...string[]]>
export const DIRECT_AUTH_DEFAULTS = Object.fromEntries(Object.keys(DIRECT_AUTH_PROVIDERS).map((id) => [id, ''])) as Record<DirectAuthKind, string>
export const DIRECT_AUTH_REFRESH = Object.fromEntries(Object.keys(DIRECT_AUTH_PROVIDERS).map((id) => [id, false])) as Record<DirectAuthKind, boolean>
