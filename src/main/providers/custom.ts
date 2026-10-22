import * as electron from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { VENDOR_BASE_URLS } from '@shared/ipc'
import { providerPreset, presetAllowsModel } from '@shared/providerPresets'
import type { ProviderPresetId } from '@shared/providerPresets'
import { SEALED_PREFIX, seal, secureStorageAvailable, unseal } from '../secrets'

/** The kinds a provider added in Settings can be. */
export const CUSTOM_KINDS = ['openai', 'ollama', 'anthropic', 'openai-api'] as const

export interface CustomProviderConfig {
  billing?: 'subscription' | 'free' | 'unknown'
  preset?: ProviderPresetId
  id: string
  label: string
  /**
   * 'openai' = hosted OpenAI-compatible gateway; 'ollama' = local, no key;
   * 'anthropic' / 'openai-api' = the vendor's own API under an API key.
   */
  kind: (typeof CUSTOM_KINDS)[number]
  baseURL: string
  apiKey: string
  apiKeys?: string[]
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
  apiKeys?: string[]
  models?: string[]
  removed?: boolean
}

/** A change made in Settings. Blank or missing fields keep what is there. */
export interface ProviderEdit {
  label?: string
  baseURL?: string
  apiKey?: string
  apiKeys?: string[]
  models?: string[]
}

interface ProvidersFile {
  providers: CustomProviderConfig[]
  builtin: Record<string, BuiltinOverride>
}

let cache: ProvidersFile | null = null

function file(): string {
  return path.join(electron.app.getPath('userData'), 'providers.json')
}

const ENCRYPTED_PREFIX = SEALED_PREFIX
const encryptKey = seal
const decryptKey = unseal
const safeStorage = (): boolean | null => (secureStorageAvailable() ? true : null)

function decoded(stored: ProvidersFile): ProvidersFile {
  return {
    providers: stored.providers.map((provider) => ({ ...provider, apiKey: decryptKey(provider.apiKey), ...(provider.apiKeys ? { apiKeys: provider.apiKeys.map(decryptKey).filter(Boolean) } : {}) })),
    builtin: Object.fromEntries(Object.entries(stored.builtin).map(([id, override]) => [
      id,
      { ...override, ...(override.apiKey !== undefined ? { apiKey: decryptKey(override.apiKey) } : {}), ...(override.apiKeys ? { apiKeys: override.apiKeys.map(decryptKey).filter(Boolean) } : {}) }
    ]))
  }
}

function encoded(stored: ProvidersFile): ProvidersFile {
  return {
    providers: stored.providers.map((provider) => ({ ...provider, apiKey: encryptKey(provider.apiKey), ...(provider.apiKeys ? { apiKeys: provider.apiKeys.map(encryptKey) } : {}) })),
    builtin: Object.fromEntries(Object.entries(stored.builtin).map(([id, override]) => [
      id,
      { ...override, ...(override.apiKey !== undefined ? { apiKey: encryptKey(override.apiKey) } : {}), ...(override.apiKeys ? { apiKeys: override.apiKeys.map(encryptKey) } : {}) }
    ]))
  }
}

function load(): ProvidersFile {
  if (cache !== null) return cache
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<ProvidersFile>
    const stored = {
      providers: Array.isArray(parsed.providers) ? parsed.providers : [],
      builtin:
        parsed.builtin !== null && typeof parsed.builtin === 'object' && !Array.isArray(parsed.builtin)
          ? parsed.builtin
          : {}
    } satisfies ProvidersFile
    cache = decoded(stored)
    const plaintext = [...stored.providers, ...Object.values(stored.builtin)].some((provider) =>
      [provider.apiKey ?? '', ...(provider.apiKeys ?? [])].some(key => key !== '' && !key.startsWith(ENCRYPTED_PREFIX)))
    // Transparently migrate legacy plaintext files the first time they are read.
    if (plaintext && safeStorage() !== null) save(cache)
  } catch {
    cache = { providers: [], builtin: {} }
  }
  return cache
}

function save(next: ProvidersFile): void {
  if ([...next.providers, ...Object.values(next.builtin)].some(provider => [provider.apiKey ?? '', ...(provider.apiKeys ?? [])].some(Boolean)) && !secureStorageAvailable()) throw new Error('Secure storage is unavailable. Unlock the system keychain before saving API keys.')
  cache = next
  mkdirSync(path.dirname(file()), { recursive: true })
  // On macOS/Windows safeStorage delegates to Keychain/DPAPI. Atomic replace
  // also prevents a crash during Settings save from erasing every provider.
  const temporary = `${file()}.tmp`
  writeFileSync(temporary, JSON.stringify(encoded(next), null, 2), { mode: 0o600 })
  renameSync(temporary, file())
}

export function listCustomProviders(): CustomProviderConfig[] {
  return load().providers
}

/** One-time import of a user-configured legacy connection, preserving its id. */
export function importLegacyProvider(config: CustomProviderConfig): void {
  const stored = load()
  if (stored.providers.some(provider => provider.id === config.id)) return
  save({ ...stored, providers: [...stored.providers, config], builtin: { ...stored.builtin, [config.id]: { removed: true } } })
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
 * and repeats dropped, order kept, the first is the one a provider starts on.
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
  if (!(CUSTOM_KINDS as readonly string[]).includes(input.kind)) throw new Error('Unknown provider type')
  // A vendor API needs no Base URL typed; the vendor's own is the default.
  const baseURL = checkedBaseURL(input.baseURL.trim() !== '' ? input.baseURL : (VENDOR_BASE_URLS[input.kind] ?? ''))
  validatePreset({ ...input, baseURL })
  const config: CustomProviderConfig = {
    ...input,
    baseURL,
    apiKeys: cleanApiKeys([input.apiKey, ...(input.apiKeys ?? [])]),
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
    ...(edit.baseURL?.trim() && checkedBaseURL(edit.baseURL) !== existing.baseURL && existing.billing === 'subscription' ? { billing: 'unknown' as const } : {}),
    label: edit.label?.trim() || existing.label,
    baseURL: edit.baseURL?.trim() ? checkedBaseURL(edit.baseURL) : existing.baseURL,
    apiKey: edit.apiKey?.trim() || existing.apiKey,
    apiKeys: cleanApiKeys([edit.apiKey?.trim() || existing.apiKey, ...(existing.apiKeys ?? []).filter((key) => key !== existing.apiKey), ...(edit.apiKeys ?? [])]),
    models: edit.models !== undefined ? cleanModelIds(edit.models) : (existing.models ?? [])
  }
  validatePreset(next)
  save({ ...stored, providers: stored.providers.map((entry) => (entry.id === id ? next : entry)) })
}

export function removeCustomProvider(id: string): void {
  const stored = load()
  save({ ...stored, providers: stored.providers.filter((entry) => entry.id !== id) })
}

/** Check again on requests, including profiles created by older versions. */
export function validatePreset(config: Pick<CustomProviderConfig, 'preset' | 'baseURL' | 'kind' | 'models'>, model?: string): void {
  if (config.preset === undefined) return
  const preset = providerPreset(config.preset)
  if (!preset || config.kind !== 'openai' || normalizeBaseURL(config.baseURL) !== preset.baseURL) throw new Error('This free connection must use its original provider endpoint. Add a separate provider for another endpoint.')
  for (const id of model === undefined ? config.models ?? [] : [model]) {
    if (!presetAllowsModel(preset.id, id)) throw new Error(`The ${preset.label} connection accepts free model routes only. Choose a free model; paid aliases are not used automatically.`)
  }
}

export function builtinOverride(id: string): BuiltinOverride {
  return load().builtin[id] ?? {}
}

export function setBuiltinOverride(id: string, next: BuiltinOverride): void {
  const stored = load()
  save({ ...stored, builtin: { ...stored.builtin, [id]: next } })
}


export function cleanApiKeys(keys: unknown): string[] {
  if (!Array.isArray(keys)) return []
  const result = [...new Set(keys.filter((key): key is string => typeof key === 'string').map(key => key.trim()).filter(Boolean))]
  if (result.length > 20 || result.some(key => /\s/.test(key) || key.length > 8192)) throw new Error('Enter up to 20 API keys, one per line, without spaces.')
  return result
}
