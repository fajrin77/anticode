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
  /** Model ids typed in Settings, for gateways whose /models is missing or short. */
  models?: string[]
}

/**
 * What Settings changed about a provider the app ships with. Its credentials
 * start in the env file; anything set here wins over them, and `removed`
 * takes it out of every list until it is restored.
 */
export interface BuiltinOverride {
  label?: string
  baseURL?: string
  apiKey?: string
  models?: string[]
  removed?: boolean
}

/** A change made in Settings. Blank or missing fields keep what is there. */
export interface ProviderEdit {
  label?: string
  baseURL?: string
  apiKey?: string
  models?: string[]
}

interface ProvidersFile {
  providers: CustomProviderConfig[]
  builtin: Record<string, BuiltinOverride>
}

let cache: ProvidersFile | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'providers.json')
}

function load(): ProvidersFile {
  if (cache !== null) return cache
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<ProvidersFile>
    cache = {
      providers: Array.isArray(parsed.providers) ? parsed.providers : [],
      builtin:
        parsed.builtin !== null && typeof parsed.builtin === 'object' && !Array.isArray(parsed.builtin)
          ? parsed.builtin
          : {}
    }
  } catch {
    cache = { providers: [], builtin: {} }
  }
  return cache
}

function save(next: ProvidersFile): void {
  cache = next
  mkdirSync(path.dirname(file()), { recursive: true })
  // Keys live here, so keep the file owner-only.
  writeFileSync(file(), JSON.stringify(next, null, 2), { mode: 0o600 })
}

export function listCustomProviders(): CustomProviderConfig[] {
  return load().providers
}

export function getCustomProvider(id: string): CustomProviderConfig | undefined {
  return load().providers.find((entry) => entry.id === id)
}

/** Users paste the full chat URL or forget /v1; both break every call. */
export function normalizeBaseURL(url: string): string {
  let out = url.trim().replace(/\/+$/, '')
  if (out.endsWith('/chat/completions')) {
    out = out.slice(0, -'/chat/completions'.length).replace(/\/+$/, '')
  }
  return out
}

/** A base URL as it will be stored, or an error a person can act on. */
export function checkedBaseURL(input: string): string {
  const baseURL = normalizeBaseURL(input)
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    throw new Error('Base URL is not a valid URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL must use http or https')
  return baseURL
}

/**
 * Model ids as typed: commas or new lines between them, surrounding blanks
 * and repeats dropped, order kept — the first is the one a provider starts on.
 */
export function cleanModelIds(input: unknown): string[] {
  const raw = Array.isArray(input) ? input.join('\n') : typeof input === 'string' ? input : ''
  const ids: string[] = []
  for (const part of raw.split(/[\n,]/)) {
    const id = part.trim()
    if (id !== '' && id.length <= 200 && !ids.includes(id)) ids.push(id)
  }
  return ids.slice(0, 200)
}

export function addCustomProvider(input: Omit<CustomProviderConfig, 'id'>): CustomProviderConfig {
  const baseURL = checkedBaseURL(input.baseURL)
  if (!['openai', 'ollama'].includes(input.kind)) throw new Error('Unknown provider type')
  const config: CustomProviderConfig = {
    ...input,
    baseURL,
    models: cleanModelIds(input.models),
    id: `custom:${randomUUID()}`
  }
  const stored = load()
  save({ ...stored, providers: [...stored.providers, config] })
  return config
}

export function updateCustomProvider(id: string, edit: ProviderEdit): void {
  const stored = load()
  const existing = stored.providers.find((entry) => entry.id === id)
  if (existing === undefined) throw new Error('Unknown provider')
  const next: CustomProviderConfig = {
    ...existing,
    label: edit.label?.trim() || existing.label,
    baseURL: edit.baseURL?.trim() ? checkedBaseURL(edit.baseURL) : existing.baseURL,
    apiKey: edit.apiKey?.trim() || existing.apiKey,
    models: edit.models !== undefined ? cleanModelIds(edit.models) : (existing.models ?? [])
  }
  save({ ...stored, providers: stored.providers.map((entry) => (entry.id === id ? next : entry)) })
}

export function removeCustomProvider(id: string): void {
  const stored = load()
  save({ ...stored, providers: stored.providers.filter((entry) => entry.id !== id) })
}

export function builtinOverride(id: string): BuiltinOverride {
  return load().builtin[id] ?? {}
}

export function setBuiltinOverride(id: string, next: BuiltinOverride): void {
  const stored = load()
  save({ ...stored, builtin: { ...stored.builtin, [id]: next } })
}
