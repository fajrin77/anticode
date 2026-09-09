import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface CustomProviderConfig {
  id: string
  label: string
  /** 'openai' = hosted OpenAI-compatible gateway; 'ollama' = local, no key. */
  kind: 'openai' | 'ollama'
  baseURL: string
  apiKey: string
}

let cache: CustomProviderConfig[] | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'providers.json')
}

function load(): CustomProviderConfig[] {
  if (cache !== null) return cache
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as {
      providers?: CustomProviderConfig[]
    }
    cache = Array.isArray(parsed.providers) ? parsed.providers : []
  } catch {
    cache = []
  }
  return cache
}

function save(list: CustomProviderConfig[]): void {
  cache = list
  mkdirSync(path.dirname(file()), { recursive: true })
  // Keys live here, so keep the file owner-only.
  writeFileSync(file(), JSON.stringify({ providers: list }, null, 2), { mode: 0o600 })
}

export function listCustomProviders(): CustomProviderConfig[] {
  return load()
}

export function getCustomProvider(id: string): CustomProviderConfig | undefined {
  return load().find((entry) => entry.id === id)
}

/** Users paste the full chat URL or forget /v1; both break every call. */
export function normalizeBaseURL(url: string): string {
  let out = url.trim().replace(/\/+$/, '')
  if (out.endsWith('/chat/completions')) {
    out = out.slice(0, -'/chat/completions'.length).replace(/\/+$/, '')
  }
  return out
}

export function addCustomProvider(input: Omit<CustomProviderConfig, 'id'>): CustomProviderConfig {
  const config: CustomProviderConfig = {
    ...input,
    baseURL: normalizeBaseURL(input.baseURL),
    id: `custom:${randomUUID()}`
  }
  save([...load(), config])
  return config
}

export function removeCustomProvider(id: string): void {
  save(load().filter((entry) => entry.id !== id))
}
