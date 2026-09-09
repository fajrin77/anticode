import type { ProviderId, ProviderInfo } from '@shared/ipc'
import { AnthropicProvider } from './anthropic'
import { getCustomProvider, listCustomProviders } from './custom'
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
 * anticode ships with a single provider: the Clinepass gateway. Its
 * subscription models are listed in models.ts; other adapters stay compiled
 * but are not offered.
 */
export function listProviders(): ProviderInfo[] {
  const builtIn: ProviderInfo[] = [
    {
      id: 'clinepass',
      label: 'Clinepass',
      defaultModel: env('CLINEPASS_MODEL') ?? '',
      credentialAvailable: env('CLINEPASS_API_KEY') !== null && env('CLINEPASS_BASE_URL') !== null,
      configured: env('CLINEPASS_API_KEY') !== null && env('CLINEPASS_BASE_URL') !== null,
      credentialHint: 'CLINEPASS_API_KEY and CLINEPASS_BASE_URL'
    }
  ]

  // User-added endpoints from Settings: hosted OpenAI-compatible gateways and
  // local servers (Ollama, LM Studio, vLLM, anything speaking /v1).
  const custom = listCustomProviders().map((config) => ({
    id: config.id,
    label: config.label,
    defaultModel: '',
    credentialAvailable: config.kind === 'ollama' || config.apiKey !== '',
    configured: config.kind === 'ollama' || config.apiKey !== '',
    credentialHint: config.kind === 'ollama' ? 'Local endpoint' : 'API key'
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
      const apiKey = env('CLINEPASS_API_KEY')
      const baseURL = env('CLINEPASS_BASE_URL')
      if (apiKey === null) throw new Error('CLINEPASS_API_KEY is not set')
      // No default URL is guessed: the gateway endpoint is deployment-specific.
      if (baseURL === null) throw new Error('CLINEPASS_BASE_URL is not set')
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
