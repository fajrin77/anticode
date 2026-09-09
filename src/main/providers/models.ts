import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenAI } from '@google/genai'
import type { ProviderId } from '@shared/ipc'

const TIMEOUT_MS = 15_000

function env(name: string): string | null {
  const value = process.env[name]?.trim()
  return value !== undefined && value !== '' ? value : null
}

async function listOpenAICompatible(apiKey: string, baseURL?: string): Promise<string[]> {
  const client = new OpenAI({
    apiKey,
    timeout: TIMEOUT_MS,
    ...(baseURL !== undefined ? { baseURL } : {})
  })
  const ids: string[] = []
  for await (const model of client.models.list()) ids.push(model.id)
  return ids
}

async function listAnthropic(apiKey: string): Promise<string[]> {
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS })
  const ids: string[] = []
  for await (const model of client.models.list({ limit: 100 })) ids.push(model.id)
  return ids
}

async function listGoogle(apiKey: string): Promise<string[]> {
  const client = new GoogleGenAI({ apiKey })
  const ids: string[] = []
  for await (const model of await client.models.list()) {
    // Gemini names models "models/gemini-…"; requests take the bare id.
    if (model.name !== undefined) ids.push(model.name.replace(/^models\//, ''))
  }
  return ids
}

/**
 * Asks the provider which models the key can actually reach, so the user never
 * has to know an id by heart. Providers that expose no catalogue simply return
 * an empty list and the UI falls back to a free-text id.
 */
export async function fetchModels(id: ProviderId): Promise<string[]> {
  switch (id) {
    case 'anthropic': {
      const apiKey = env('ANTHROPIC_API_KEY')
      return apiKey === null ? [] : listAnthropic(apiKey)
    }
    case 'openai': {
      const apiKey = env('OPENAI_API_KEY')
      return apiKey === null ? [] : listOpenAICompatible(apiKey)
    }
    case 'google': {
      const apiKey = env('GOOGLE_API_KEY')
      return apiKey === null ? [] : listGoogle(apiKey)
    }
    case 'ollama':
      return listOpenAICompatible('ollama', env('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434/v1')
    case 'clinepass': {
      const apiKey = env('CLINEPASS_API_KEY')
      const baseURL = env('CLINEPASS_BASE_URL')
      return apiKey === null || baseURL === null ? [] : listOpenAICompatible(apiKey, baseURL)
    }
  }
}
