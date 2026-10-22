import { isExplicitClineFreeModel, preferredClineFreeRoute } from '@shared/clineModels'
import { presetAllowsModel } from '@shared/providerPresets'
import { readAuthTokens } from './store'
import { MINIMAX_PLAN_MODELS } from './minimaxPlan'
import { VERCEL_GATEWAY_BASE } from './vercel'
import { ensureFreshAuthTokens, AUTH_MODELS } from './provider'
import { CLINE_API_BASE, CLINE_HEADERS, clineApiToken } from '../providers/clineConfig'
import { CODEX_BASE_URL, CODEX_CLIENT_VERSION } from '../providers/codexConfig'
import type { AuthKind } from './types'
import { loadPersistedSettings, savePersistedSettings } from '../settings'
import { checkClaudeSubscription } from './claudeAccess'
import { CLAUDE_CODE_HEADERS } from '../providers/anthropic'

export function authModelsFor(id: string, kind: AuthKind): string[] {
  if (kind === 'minimax-plan') {
    try {
      const models: unknown = JSON.parse(readAuthTokens(id)?.meta?.planModels ?? '[]')
      return Array.isArray(models) ? models.filter((model): model is string => typeof model === 'string' && (MINIMAX_PLAN_MODELS as readonly string[]).includes(model)) : []
    } catch { return [] }
  }
  const models = loadPersistedSettings().authModelCatalogues?.[id]?.models
  const valid = (kind === 'clinepass' || kind === 'codex' || kind === 'cline' || kind === 'claude' || kind === 'kilo' || kind === 'openrouter' || kind === 'vercel') && Array.isArray(models)
    ? models.filter((model): model is string => typeof model === 'string' && model.trim() !== '') : []
  if (kind === 'clinepass') {
    const saved = readAuthTokens(id)?.meta?.planModels
    let configured: string[] = []
    try { const parsed: unknown = JSON.parse(saved ?? '[]'); if (Array.isArray(parsed)) configured = parsed.filter((v): v is string => typeof v === 'string') } catch { /* Fall back to the bounded plan catalogue. */ }
    return [...new Set((configured.length ? configured : valid.length ? valid : AUTH_MODELS.clinepass).filter(model => model.startsWith('cline-pass/')))]
  }
  if (kind === 'cline') {
    const freeOnly = loadPersistedSettings().authModelCatalogues?.[id]?.freeOnly === true
    const available = freeOnly ? valid : [...AUTH_MODELS.cline, ...valid.filter(isExplicitClineFreeModel)]
    const usable = available.filter((model) => !clineRestriction(id, model))
    return [...new Set(usable.map((model) => preferredClineFreeRoute(model, usable)))]
  }
  if (kind === 'claude' && valid.length) return [...new Set(valid.filter(model => model.startsWith('claude-')))]
  if (kind === 'kilo' || kind === 'openrouter') return [...new Set((Array.isArray(models) ? valid : AUTH_MODELS[kind]).filter(model => presetAllowsModel(kind === 'kilo' ? 'kilo-free' : 'openrouter-free', model)))]
  // Gateway accounts only ever list free routes, new ones first from the live list.
  if (kind === 'vercel') return [...new Set(valid.filter(model => presetAllowsModel('vercel-free', model)))]
  // Retain the public bundled choices when an older account snapshot is short.
  // The provider still validates model access at request time.
  return [...new Set([...AUTH_MODELS[kind], ...valid])]
}

export async function fetchFreeGatewayModels(id: string, kind: 'kilo' | 'openrouter' | 'vercel'): Promise<string[]> {
  const tokens = await ensureFreshAuthTokens(id)
  const base = kind === 'kilo' ? 'https://ai-gateway.kilo.ai/api/v1' : kind === 'vercel' ? VERCEL_GATEWAY_BASE : 'https://openrouter.ai/api/v1'
  try {
    const response = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (response.ok) {
      const data = await response.json() as { data?: { id?: unknown }[] }
      if (Array.isArray(data.data)) {
        const models = data.data.flatMap(entry => typeof entry.id === 'string' && presetAllowsModel(kind === 'kilo' ? 'kilo-free' : kind === 'vercel' ? 'vercel-free' : 'openrouter-free', entry.id) ? [entry.id] : [])
        savePersistedSettings({ authModelCatalogues: { ...loadPersistedSettings().authModelCatalogues, [id]: { models: [...new Set(models)], checkedAt: Date.now(), freeOnly: true } } })
      }
    }
  } catch { /* Keep the last free catalogue on network or malformed-response failures. */ }
  return authModelsFor(id, kind)
}

export async function fetchClaudeModels(id: string): Promise<string[]> {
  const tokens = await ensureFreshAuthTokens(id)
  try {
    const models: string[] = []
    let after: string | undefined
    for (let page = 0; page < 10; page++) {
      const url = new URL('https://api.anthropic.com/v1/models')
      url.searchParams.set('limit', '100')
      if (after) url.searchParams.set('after_id', after)
      const response = await fetch(url.toString(), { headers: { ...CLAUDE_CODE_HEADERS, authorization: `Bearer ${tokens.accessToken}`, 'anthropic-version': '2023-06-01', accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error('Claude catalogue unavailable')
      const data = await response.json() as { data?: { id?: unknown }[]; has_more?: boolean; last_id?: string }
      if (!Array.isArray(data.data)) throw new Error('Invalid Claude catalogue')
      models.push(...data.data.flatMap(entry => typeof entry.id === 'string' && entry.id.startsWith('claude-') ? [entry.id] : []))
      if (!data.has_more) break
      if (!data.last_id || data.last_id === after || page === 9) throw new Error('Incomplete Claude catalogue')
      after = data.last_id
    }
    if (models.length) savePersistedSettings({ authModelCatalogues: { ...loadPersistedSettings().authModelCatalogues, [id]: { models: [...new Set(models)], checkedAt: Date.now() } } })
  } catch { /* Retain the last successful account catalogue while offline. */ }
  try { await checkClaudeSubscription(id, tokens) } catch { /* Inference checks again and explains blocked billing. */ }
  return authModelsFor(id, 'claude')
}

/** Provider-denied routes cool down across refresh/restart instead of failing every Continue. */
export function clineRestriction(id: string, model: string): string | null {
  const restriction = loadPersistedSettings().authModelCatalogues?.[id]?.unavailable?.[model]
  return restriction && restriction.until > Date.now() ? restriction.reason : null
}

export function markClineRestricted(id: string, model: string, reason: string): void {
  const catalogues = loadPersistedSettings().authModelCatalogues ?? {}
  const previous = catalogues[id]
  savePersistedSettings({ authModelCatalogues: { ...catalogues, [id]: {
    models: previous?.models ?? [...AUTH_MODELS.cline], checkedAt: previous?.checkedAt ?? Date.now(),
    ...(previous?.freeOnly ? { freeOnly: true } : {}),
    unavailable: { ...previous?.unavailable, [model]: { reason, until: Date.now() + 15 * 60_000 } }
  } } })
}

export function forgetAuthCatalogue(id: string): void {
  const previous = loadPersistedSettings().authModelCatalogues ?? {}
  if (!(id in previous)) return
  const next = { ...previous }
  delete next[id]
  savePersistedSettings({ authModelCatalogues: next })
}

export function parseCodexModels(value: unknown): string[] {
  const raw = value as { models?: unknown; data?: unknown } | null
  const entries = raw?.models ?? raw?.data
  if (!Array.isArray(entries)) return []
  return [...new Set(entries.flatMap((value) => {
    if (value === null || typeof value !== 'object') return []
    const entry = value as { slug?: unknown; id?: unknown; visibility?: unknown; supported_in_api?: unknown }
    const id = entry.slug ?? entry.id
    // Public API support is separate from availability in the signed-in Codex catalogue.
    return typeof id === 'string' && id.trim() && entry.visibility !== 'hide'
      ? [id] : []
  }))]
}

export async function fetchCodexModels(id: string): Promise<string[]> {
  const tokens = await ensureFreshAuthTokens(id)
  try {
    const response = await fetch(`${CODEX_BASE_URL}/models?client_version=${CODEX_CLIENT_VERSION}`, {
      headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json',
        originator: 'codex_cli_rs',
        'user-agent': `codex_cli_rs/${CODEX_CLIENT_VERSION}`,
        ...(tokens.meta?.accountId ? { 'chatgpt-account-id': tokens.meta.accountId } : {}) },
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) throw new Error('Account catalogue unavailable')
    const models = parseCodexModels(await response.json())
    if (models.length) {
      savePersistedSettings({ authModelCatalogues: {
        ...loadPersistedSettings().authModelCatalogues,
        [id]: { models, checkedAt: Date.now() }
      } })
      return authModelsFor(id, 'codex')
    }
  } catch { /* Account/network failure: retain a bounded offline fallback. */ }
  return authModelsFor(id, 'codex')
}


/** /models carries public :free aliases; Cline promotions are in a separate feed. */
export function parseClineFreeModels(catalogue: unknown, recommendations: unknown): string[] {
  const raw = catalogue as { data?: unknown } | null
  const entries = Array.isArray(catalogue) ? catalogue : raw?.data
  const free = (recommendations as { free?: unknown } | null)?.free
  const ids = (list: unknown): string[] => Array.isArray(list) ? list.flatMap((entry: unknown) => {
    const id = (entry as { id?: unknown } | null)?.id
    return typeof id === 'string' && id.trim() ? [id.trim()] : []
  }) : []
  return [...new Set([
    ...ids(free).filter((id) => !id.startsWith('cline-pass/')),
    ...ids(entries).filter(isExplicitClineFreeModel)
  ])]
}

export async function fetchClineModels(id: string): Promise<string[]> {
  const tokens = await ensureFreshAuthTokens(id)
  const sources = await Promise.allSettled([
    fetch(`${CLINE_API_BASE}/models`, {
      headers: { ...CLINE_HEADERS, authorization: `Bearer ${clineApiToken(tokens.accessToken)}` },
      signal: AbortSignal.timeout(10_000)
    }).then(async (response) => response.ok ? response.json() : null),
    fetch(`${CLINE_API_BASE}/ai/cline/recommended-models`, {
      headers: { ...CLINE_HEADERS, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000)
    }).then(async (response) => response.ok ? response.json() : null)
  ])
  const models = parseClineFreeModels(
    sources[0].status === 'fulfilled' ? sources[0].value : null,
    sources[1].status === 'fulfilled' ? sources[1].value : null
  )
  if (models.length) {
    savePersistedSettings({ authModelCatalogues: {
      ...loadPersistedSettings().authModelCatalogues,
      [id]: { models, checkedAt: Date.now(), freeOnly: true, unavailable: loadPersistedSettings().authModelCatalogues?.[id]?.unavailable ?? {} }
    } })
  }
  return authModelsFor(id, 'cline')
}

export async function fetchClinePassModels(id: string): Promise<string[]> {
  const tokens = await ensureFreshAuthTokens(id)
  try {
    const response = await fetch(`${CLINE_API_BASE}/models`, { headers: { ...CLINE_HEADERS, authorization: `Bearer ${clineApiToken(tokens.accessToken)}` }, signal: AbortSignal.timeout(10_000) })
    if (response.ok) {
      const raw = await response.json() as { data?: { id?: unknown }[] }
      const models = raw.data?.flatMap(row => typeof row.id === 'string' && row.id.startsWith('cline-pass/') ? [row.id] : []) ?? []
      if (models.length) savePersistedSettings({ authModelCatalogues: { ...loadPersistedSettings().authModelCatalogues, [id]: { models: [...new Set(models)], checkedAt: Date.now() } } })
    }
  } catch { /* Keep the last plan catalogue while offline. */ }
  return authModelsFor(id, 'clinepass')
}
