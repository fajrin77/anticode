import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenAI } from '@google/genai'
import type { ProviderId } from '@shared/ipc'
import { getCustomProvider } from './custom'
import { clinepassConfig } from './clinepass'
import { anthropicBaseURL } from './anthropic'
import { recordPublishedPrices } from '../pricing'

const TIMEOUT_MS = 15_000

function env(name: string): string | null {
  const value = process.env[name]?.trim()
  return value !== undefined && value !== '' ? value : null
}

async function listOpenAICompatible(apiKey: string, baseURL?: string, provider?: ProviderId): Promise<string[]> {
  const client = new OpenAI({
    apiKey,
    timeout: TIMEOUT_MS,
    ...(baseURL !== undefined ? { baseURL } : {})
  })
  const ids: string[] = []
  const priced: { id: string; pricing?: unknown }[] = []
  for await (const model of client.models.list()) {
    ids.push(model.id)
    // Gateways in OpenRouter's mould say what each model costs; keep that.
    priced.push({ id: model.id, pricing: (model as unknown as { pricing?: unknown }).pricing })
  }
  if (provider !== undefined) recordPublishedPrices(provider, priced)
  return ids
}

/** Verifies a local OpenAI-compatible server before its configuration is saved. */
export async function probeLocalProvider(baseURL: string): Promise<void> {
  try {
    await listOpenAICompatible('ollama', baseURL)
  } catch (error) {
    throw new Error(`Could not reach the local provider. ${sanitizeModelFetchError(error)}. Check that the server is running and the Base URL is correct.`)
  }
}

async function listAnthropic(apiKey: string, baseURL?: string): Promise<string[]> {
  const client = new Anthropic({
    apiKey,
    timeout: TIMEOUT_MS,
    ...(baseURL !== undefined ? { baseURL: anthropicBaseURL(baseURL) } : {})
  })
  const ids: string[] = []
  for await (const model of client.models.list({ limit: 100 })) ids.push(model.id)
  return ids
}

/**
 * OpenAI's own list mixes chat models with embeddings, speech, images, and
 * moderation. None of those can hold a conversation, so they are left out
 * of a picker that only ever starts one.
 */
const NOT_CHAT = /(embedding|tts|whisper|transcribe|dall-e|gpt-image|image|moderation|realtime|audio|search|babbage|davinci)/i

export function chatModelsOnly(ids: string[]): string[] {
  return ids.filter((id) => !NOT_CHAT.test(id))
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
      const fetched =
        config.kind === 'anthropic'
          ? await listAnthropic(config.apiKey, config.baseURL)
          : config.kind === 'openai-api'
            ? chatModelsOnly(await listOpenAICompatible(config.apiKey, config.baseURL))
            : await listOpenAICompatible(config.kind === 'ollama' ? 'ollama' : config.apiKey, config.baseURL, id)
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
