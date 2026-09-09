import type { ProviderId, ProviderInfo } from '@shared/ipc'
import { AnthropicProvider } from './anthropic'
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
 * Only Anthropic gets a default model: the current model names of the other
 * providers change often, and a stale guess fails at request time with a
 * confusing error. The user names the model instead.
 */
export function listProviders(): ProviderInfo[] {
  return [
    {
      id: 'anthropic',
      label: 'Anthropic',
      defaultModel: env('ANTHROPIC_MODEL') ?? 'claude-opus-5',
      credentialAvailable: env('ANTHROPIC_API_KEY') !== null,
      configured: env('ANTHROPIC_API_KEY') !== null,
      credentialHint: 'ANTHROPIC_API_KEY'
    },
    {
      id: 'openai',
      label: 'OpenAI',
      defaultModel: env('OPENAI_MODEL') ?? '',
      credentialAvailable: env('OPENAI_API_KEY') !== null,
      configured: env('OPENAI_API_KEY') !== null,
      credentialHint: 'OPENAI_API_KEY'
    },
    {
      id: 'google',
      label: 'Google Gemini',
      defaultModel: env('GOOGLE_MODEL') ?? '',
      credentialAvailable: env('GOOGLE_API_KEY') !== null,
      configured: env('GOOGLE_API_KEY') !== null,
      credentialHint: 'GOOGLE_API_KEY'
    },
    {
      id: 'ollama',
      label: 'Ollama (lokal)',
      defaultModel: env('OLLAMA_MODEL') ?? '',
      // Ollama needs no key, so it is always "available" — but only counts as
      // configured when the user names an endpoint, otherwise it would win the
      // automatic pick from every other provider that does have a key.
      credentialAvailable: true,
      configured: env('OLLAMA_BASE_URL') !== null,
      credentialHint: ollamaBaseUrl()
    },
    {
      id: 'clinepass',
      label: 'Clinepass',
      defaultModel: env('CLINEPASS_MODEL') ?? '',
      credentialAvailable: env('CLINEPASS_API_KEY') !== null && env('CLINEPASS_BASE_URL') !== null,
      configured: env('CLINEPASS_API_KEY') !== null && env('CLINEPASS_BASE_URL') !== null,
      credentialHint: 'CLINEPASS_API_KEY dan CLINEPASS_BASE_URL'
    }
  ]
}

export function createProvider(id: ProviderId, model: string): LLMProvider {
  switch (id) {
    case 'anthropic': {
      const apiKey = env('ANTHROPIC_API_KEY')
      if (apiKey === null) throw new Error('ANTHROPIC_API_KEY belum diset')
      return new AnthropicProvider(apiKey, model)
    }
    case 'openai': {
      const apiKey = env('OPENAI_API_KEY')
      if (apiKey === null) throw new Error('OPENAI_API_KEY belum diset')
      return new OpenAICompatibleProvider('openai', model, {
        apiKey,
        maxTokensField: 'max_completion_tokens'
      })
    }
    case 'google': {
      const apiKey = env('GOOGLE_API_KEY')
      if (apiKey === null) throw new Error('GOOGLE_API_KEY belum diset')
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
      if (apiKey === null) throw new Error('CLINEPASS_API_KEY belum diset')
      // No default URL is guessed: the gateway endpoint is deployment-specific.
      if (baseURL === null) throw new Error('CLINEPASS_BASE_URL belum diset')
      return new OpenAICompatibleProvider('clinepass', model, {
        apiKey,
        baseURL,
        maxTokensField: 'max_tokens'
      })
    }
  }
}
