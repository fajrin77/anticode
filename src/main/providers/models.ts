import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenAI } from '@google/genai'
import type { ProviderId } from '@shared/ipc'
import { getCustomProvider } from './custom'
import { clinepassConfig } from './clinepass'

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
function sanitizeModelFetchError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const status = (error as { status?: unknown }).status
  const noTags = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  const clipped = noTags.length > 160 ? `${noTags.slice(0, 160)}…` : noTags
  const code = typeof status === 'number' ? `HTTP ${status}` : 'Request failed'
  const hint = status === 404 ? ' — the Base URL is usually missing /v1' : ''
  return `${code}: ${clipped}${hint}`
}

export async function fetchModels(id: ProviderId): Promise<string[]> {
  try {
    return await fetchModelList(id)
  } catch (error) {
    throw new Error(sanitizeModelFetchError(error))
  }
}

async function fetchModelList(id: ProviderId): Promise<string[]> {
  if (id.startsWith('custom:')) {
    const config = getCustomProvider(id)
    if (config === undefined) return []
    // The ids typed in Settings always count; the gateway's own list adds to
    // them, and when it cannot be read the typed ones are the catalogue.
    const listed = config.models ?? []
    try {
      const fetched = await listOpenAICompatible(config.kind === 'ollama' ? 'ollama' : config.apiKey, config.baseURL)
      return [...listed, ...fetched.filter((model) => !listed.includes(model))]
    } catch (error) {
      if (listed.length > 0) return listed
      throw error
    }
  }

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
      const { apiKey, baseURL, models, removed } = clinepassConfig()
      return removed || apiKey === null || baseURL === null ? [] : models
    }
    default:
      return []
  }
}
