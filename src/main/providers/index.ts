import { migrateClinePassAccount } from '../auth/clinepassMigration'
import type { ProviderId, ProviderInfo } from '@shared/ipc'
import { modelIsBatchOnly } from '@shared/ipc'
import { isDirectAuthKind } from '@shared/directAuthProviders'
import { keyringProvider } from './keyring'
import { withOpenCodeSession } from './opencodeGo'
import { composerProviders } from './visibility'
import { AnthropicProvider } from './anthropic'
import { getCustomProvider, listCustomProviders, validatePreset } from './custom'
import { presetAllowsModel } from '@shared/providerPresets'
import { canonicalClinepassModel, clinepassConfig, migrateLegacyClinepass } from './clinepass'
import { OpenAICompatibleProvider } from './openai'
import { GoogleProvider } from './google'
import type { LLMProvider } from './types'
import { listAuthAccounts, readAuthTokens } from '../auth/store'
import { authModelsFor } from '../auth/catalogue'
import { authProvider, AUTH_DEFAULT_MODELS } from '../auth/provider'

const OLLAMA_FALLBACK_URL = 'http://127.0.0.1:11434/v1'
/** Where an Anthropic provider starts when no model id was typed for it. */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5'

function env(name: string): string | null {
  const value = process.env[name]?.trim()
  return value !== undefined && value !== '' ? value : null
}

function ollamaBaseUrl(): string {
  return env('OLLAMA_BASE_URL') ?? OLLAMA_FALLBACK_URL
}

/** Providers come from this user's local configuration and connected accounts. */
export function listProviders(): ProviderInfo[] {
  migrateLegacyClinepass()
  migrateClinePassAccount()

  // User-added endpoints from Settings: hosted OpenAI-compatible gateways and
  // local servers (Ollama, LM Studio, vLLM, anything speaking /v1).
  const custom = listCustomProviders().map((config): ProviderInfo => ({
    id: config.id,
    label: config.label,
    // Anthropic's list is short enough to be auto-picked from, and sorted it
    // would start on whichever model is first alphabetically; the current
    // flagship is the sensible start. Typed ids still come first.
    defaultModel: config.models?.[0] ?? (config.kind === 'anthropic' ? ANTHROPIC_DEFAULT_MODEL : ''),
    credentialAvailable: config.kind === 'ollama' || config.apiKey !== '' || config.preset === 'kilo-free',
    configured: config.kind === 'ollama' || config.apiKey !== '' || config.preset === 'kilo-free',
    credentialHint: config.kind === 'ollama' ? 'Local endpoint' : config.preset === 'kilo-free' && !config.apiKey ? 'Anonymous free endpoint' : 'API key',
    models: (config.models ?? []).filter(model => !config.preset || presetAllowsModel(config.preset, model)),
    kind: config.kind,
    ...(config.billing ? { billing: config.billing } : {}),
    ...(config.preset ? { preset: config.preset, billing: 'free' as const } : {}),
    baseURL: config.baseURL,
    keyCount: new Set([config.apiKey, ...(config.apiKeys ?? [])].filter(Boolean)).size,
    hasKey: config.apiKey !== ''
  }))

  // OAuth accounts added in Settings → Auth provider. Each is a provider id of
  // its own (`auth:codex`, `auth:codex-2`, …) so two logins of the same vendor
  // sit side by side and can be rotated between like any other entry.
  const auth = listAuthAccounts().map((account): ProviderInfo => {
    const tokens = readAuthTokens(account.id)
    const models = authModelsFor(account.id, account.kind)
    return {
      id: account.id,
      label: account.label,
      defaultModel: models[0] ?? AUTH_DEFAULT_MODELS[account.kind],
      credentialAvailable: tokens !== null,
      configured: true,
      credentialHint: 'OAuth account',
      models,
      kind: 'auth',
      authKind: account.kind,
      billing: isDirectAuthKind(account.kind) ? 'metered' : ['cursor', 'antigravity', 'copilot', 'codex', 'claude', 'opencode-go', 'minimax-plan', 'clinepass'].includes(account.kind) ? 'subscription' : ['cline', 'kilo', 'openrouter', 'vercel'].includes(account.kind) ? 'free' : 'unknown',
      baseURL: '',
      hasKey: tokens !== null
    }
  })

  const visibility = composerProviders()
  return [...custom, ...auth].map((provider) => ({ ...provider, models: (provider.models ?? []).filter((model) => !modelIsBatchOnly(model)), composerVisible: visibility[provider.id] === true }))
}

/**
 * `onlyKeys` narrows a keyed provider to the given keys, so the access test
 * can try each one alone; sessions never pass it.
 */
export function createProvider(id: ProviderId, model: string, onlyKeys?: string[]): LLMProvider {
  if (id === 'clinepass') { migrateLegacyClinepass(); model = canonicalClinepassModel(model) }
  // OAuth accounts go through the auth wrapper, which keeps their tokens
  // fresh and retries once on 401; sessions route here via runtime.ts.
  if (id.startsWith('auth:') || listAuthAccounts().some(account => account.id === id)) return authProvider(id, model)

  if (getCustomProvider(id)) {
    const config = getCustomProvider(id)
    if (config === undefined) throw new Error('Unknown provider')
    validatePreset(config, model)
    const create = (key: string): LLMProvider => withOpenCodeSession(model, config.baseURL, (headers) => config.kind === 'anthropic' ? new AnthropicProvider(key, model, config.baseURL, headers ? { defaultHeaders: headers } : undefined) : new OpenAICompatibleProvider(config.label, model, {
      apiKey: config.kind === 'ollama' ? 'ollama' : config.preset === 'kilo-free' && !key ? 'anonymous' : key,
      anonymous: config.preset === 'kilo-free' && !key,
      baseURL: config.baseURL,
      ...(headers ? { defaultHeaders: headers } : {}),
      // OpenAI's own API refuses max_tokens on its current models; gateways
      // and local servers mostly only know the older name.
      maxTokensField: config.kind === 'openai-api' ? 'max_completion_tokens' : 'max_tokens'
    }))
    return keyringProvider(id, model, onlyKeys ?? [config.apiKey, ...(config.apiKeys ?? [])], create)
  }

  switch (id) {
    case 'anthropic': {
      const apiKey = env('ANTHROPIC_API_KEY')
      if (apiKey === null) throw new Error('ANTHROPIC_API_KEY is not set')
      return new AnthropicProvider(apiKey, model)
    }
    case 'openai': {
      const apiKey = env('OPENAI_API_KEY')
      if (apiKey === null) throw new Error('OPENAI_API_KEY is not set')
      return new OpenAICompatibleProvider('openai', model, {
        apiKey,
        maxTokensField: 'max_completion_tokens'
      })
    }
    case 'google': {
      const apiKey = env('GOOGLE_API_KEY')
      if (apiKey === null) throw new Error('GOOGLE_API_KEY is not set')
      return new GoogleProvider(apiKey, model)
    }
    case 'ollama':
      return new OpenAICompatibleProvider('ollama', model, {
        apiKey: 'ollama',
        baseURL: ollamaBaseUrl(),
        maxTokensField: 'max_tokens'
      })
    case 'clinepass': {
      const { apiKey, apiKeys, baseURL, removed } = clinepassConfig()
      if (removed) throw new Error('Clinepass was removed in Settings')
      if (apiKey === null) throw new Error('Clinepass has no API key. Set one in Settings → Providers')
      // Custom endpoints remain supported alongside the direct service.
      if (baseURL === null) throw new Error('Clinepass has no base URL. Set one in Settings → Providers')
      return keyringProvider(id, model, onlyKeys ?? apiKeys, key => new OpenAICompatibleProvider('clinepass', canonicalClinepassModel(model), {
        apiKey: key,
        baseURL,
        maxTokensField: 'max_tokens'
      }))
    }
    default:
      throw new Error(`Unknown provider: ${id}`)
  }
}
