import type { ProviderId, ProviderInfo } from '@shared/ipc'
import { AnthropicProvider } from './anthropic'
import { getCustomProvider, listCustomProviders } from './custom'
import { clinepassConfig } from './clinepass'
import { OpenAICompatibleProvider } from './openai'
import { GoogleProvider } from './google'
import type { LLMProvider } from './types'

const OLLAMA_FALLBACK_URL = 'http://127.0.0.1:11434/v1'

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
    defaultModel: config.models?.[0] ?? '',
    credentialAvailable: config.kind === 'ollama' || config.apiKey !== '',
    configured: config.kind === 'ollama' || config.apiKey !== '',
    credentialHint: config.kind === 'ollama' ? 'Local endpoint' : 'API key',
    models: config.models ?? [],
    kind: config.kind,
    baseURL: config.baseURL,
    hasKey: config.apiKey !== ''
  }))
  return [...builtIn, ...custom]
}

export function createProvider(id: ProviderId, model: string): LLMProvider {
  if (id.startsWith('custom:')) {
    const config = getCustomProvider(id)
    if (config === undefined) throw new Error('Unknown provider')
    return new OpenAICompatibleProvider(config.label, model, {
      apiKey: config.kind === 'ollama' ? 'ollama' : config.apiKey,
      baseURL: config.baseURL,
      maxTokensField: 'max_tokens'
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
