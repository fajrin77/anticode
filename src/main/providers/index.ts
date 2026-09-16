import type { ProviderId, ProviderInfo } from '@shared/ipc'
import { AnthropicProvider } from './anthropic'
import { getCustomProvider, listCustomProviders } from './custom'
import { clinepassConfig } from './clinepass'
import { OpenAICompatibleProvider } from './openai'
import { GoogleProvider } from './google'
import type { LLMProvider } from './types'
import { listAuthAccounts, readAuthTokens } from '../auth/store'
import { authProvider, AUTH_DEFAULT_MODELS, AUTH_MODELS } from '../auth/provider'

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

/**
 * anticode ships with a single provider: the Clinepass gateway, supplied by
 * the env file and editable (or removable) in Settings. Its subscription
 * models are listed in clinepass.ts; other adapters stay compiled but are not
 * offered. Everything else is added in Settings.
 */
export function listProviders(): ProviderInfo[] {
  const clinepass = clinepassConfig()
  const ready = clinepass.apiKey !== null && clinepass.baseURL !== null
  const builtIn: ProviderInfo[] = clinepass.removed
    ? []
    : [
        {
          id: 'clinepass',
          label: clinepass.label,
          defaultModel: clinepass.modelsEdited ? (clinepass.models[0] ?? '') : (env('CLINEPASS_MODEL') ?? ''),
          credentialAvailable: ready,
          configured: ready,
          credentialHint: 'API key and base URL',
          models: clinepass.models,
          kind: 'clinepass',
          baseURL: clinepass.baseURL ?? '',
          hasKey: clinepass.apiKey !== null
        }
      ]

  // User-added endpoints from Settings: hosted OpenAI-compatible gateways and
  // local servers (Ollama, LM Studio, vLLM, anything speaking /v1).
  const custom = listCustomProviders().map((config): ProviderInfo => ({
    id: config.id,
    label: config.label,
    // Anthropic's list is short enough to be auto-picked from, and sorted it
    // would start on whichever model is first alphabetically; the current
    // flagship is the sensible start. Typed ids still come first.
    defaultModel: config.models?.[0] ?? (config.kind === 'anthropic' ? ANTHROPIC_DEFAULT_MODEL : ''),
    credentialAvailable: config.kind === 'ollama' || config.apiKey !== '',
    configured: config.kind === 'ollama' || config.apiKey !== '',
    credentialHint: config.kind === 'ollama' ? 'Local endpoint' : 'API key',
    models: config.models ?? [],
    kind: config.kind,
    baseURL: config.baseURL,
    hasKey: config.apiKey !== ''
  }))

  // OAuth accounts added in Settings → Auth provider. Each is a provider id of
  // its own (`auth:codex`, `auth:codex-2`, …) so two logins of the same vendor
  // sit side by side and can be rotated between like any other entry.
  const auth = listAuthAccounts().map((account): ProviderInfo => {
    const tokens = readAuthTokens(account.id)
    return {
      id: account.id,
      label: account.label,
      defaultModel: AUTH_DEFAULT_MODELS[account.kind],
      credentialAvailable: tokens !== null,
      configured: true,
      credentialHint: 'OAuth account',
      models: [...AUTH_MODELS[account.kind]],
      kind: 'auth',
      baseURL: '',
      hasKey: tokens !== null
    }
  })

  return [...builtIn, ...custom, ...auth]
}

export function createProvider(id: ProviderId, model: string): LLMProvider {
  // OAuth accounts go through the auth wrapper, which keeps their tokens
  // fresh and retries once on 401; sessions route here via runtime.ts.
  if (id.startsWith('auth:')) return authProvider(id, model)

  if (id.startsWith('custom:')) {
    const config = getCustomProvider(id)
    if (config === undefined) throw new Error('Unknown provider')
    if (config.kind === 'anthropic') return new AnthropicProvider(config.apiKey, model, config.baseURL)
    return new OpenAICompatibleProvider(config.label, model, {
      apiKey: config.kind === 'ollama' ? 'ollama' : config.apiKey,
      baseURL: config.baseURL,
      // OpenAI's own API refuses max_tokens on its current models; gateways
      // and local servers mostly only know the older name.
      maxTokensField: config.kind === 'openai-api' ? 'max_completion_tokens' : 'max_tokens'
    })
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
      const { apiKey, baseURL, removed } = clinepassConfig()
      if (removed) throw new Error('Clinepass was removed in Settings')
      if (apiKey === null) throw new Error('Clinepass has no API key — set one in Settings → Providers')
      // No default URL is guessed: the gateway endpoint is deployment-specific.
      if (baseURL === null) throw new Error('Clinepass has no base URL — set one in Settings → Providers')
      return new OpenAICompatibleProvider('clinepass', model, {
        apiKey,
        baseURL,
        maxTokensField: 'max_tokens'
      })
    }
    default:
      throw new Error(`Unknown provider: ${id}`)
  }
}
