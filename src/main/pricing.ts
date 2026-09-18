import type { ModelPrice, PricedModel, ProviderSelection } from '@shared/ipc'
import { loadPersistedSettings, savePersistedSettings } from './settings'

/*
 * What a model costs, in US dollars per million tokens, for the estimates in
 * the run footer, the usage popover, and Settings → Pricing. Three sources, in
 * the order they win: a price the user typed, one the gateway publishes in its
 * own model list, and the built-in list below. A model none of them knows has
 * no estimate, it is shown as unknown, never guessed.
 */

/** When the built-in prices were taken from Anthropic's published rates. */
export const BUILT_IN_PRICES_AS_OF = '2026-06-24'

/** Anthropic first-party API rates, by model family. */
const BUILT_IN: [string, ModelPrice][] = [
  ['claude-fable-5-1', { input: 10, output: 50 }],
  ['claude-fable-5', { input: 10, output: 50 }],
  ['claude-mythos-5-1', { input: 10, output: 50 }],
  ['claude-mythos-5', { input: 10, output: 50 }],
  ['claude-opus-5', { input: 5, output: 25 }],
  ['claude-opus-4-8', { input: 5, output: 25 }],
  ['claude-opus-4-7', { input: 5, output: 25 }],
  ['claude-opus-4-6', { input: 5, output: 25 }],
  ['claude-sonnet-5', { input: 2, output: 10 }],
  ['claude-sonnet-4-6', { input: 3, output: 15 }],
  ['claude-haiku-4-5', { input: 1, output: 5 }]
]

/** Prices the gateways published with their model lists, by provider and model. */
const published = new Map<string, ModelPrice>()

const key = (provider: string, model: string): string => `${provider}::${model}`

/**
 * A model id as the built-in list spells it: no gateway vendor prefix
 * (`anthropic/…`), no variant suffix (`:free`, `@20260101`), dots as dashes,
 * and no trailing snapshot date.
 */
export function familyOf(model: string): string {
  return model
    .toLowerCase()
    .split('/')
    .at(-1)!
    .replace(/[:@].*$/, '')
    .replace(/\./g, '-')
    .replace(/-\d{8}$/, '')
}

function builtIn(model: string): ModelPrice | null {
  const family = familyOf(model)
  // Longest name first, so claude-fable-5-1 is not read as claude-fable-5.
  const match = [...BUILT_IN].sort((a, b) => b[0].length - a[0].length).find(([name]) => family === name || family.startsWith(`${name}-`))
  return match?.[1] ?? null
}

function custom(): Record<string, ModelPrice> {
  return loadPersistedSettings().pricing ?? {}
}

function valid(price: unknown): price is ModelPrice {
  const record = price as ModelPrice | null
  return (
    typeof record?.input === 'number' && Number.isFinite(record.input) && record.input >= 0 &&
    typeof record.output === 'number' && Number.isFinite(record.output) && record.output >= 0
  )
}

/** The price that applies, and where it came from; null when nothing knows it. */
export function priceFor(provider: string, model: string): Pick<PricedModel, 'price' | 'source'> {
  const typed = custom()[model]
  if (valid(typed)) return { price: typed, source: 'custom' }
  const listed = published.get(key(provider, model))
  if (listed !== undefined) return { price: listed, source: 'gateway' }
  // A gateway's free tier is free whoever made the model.
  if (/:free$/i.test(model)) return { price: { input: 0, output: 0 }, source: 'free' }
  const known = builtIn(model)
  if (known !== null) return { price: known, source: 'built-in' }
  return { price: null, source: 'unknown' }
}

/** Dollars for one request, or null when the model has no price. */
export function costOf(provider: string, model: string, inputTokens: number, outputTokens: number): number | null {
  const { price } = priceFor(provider, model)
  if (price === null) return null
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000
}

/**
 * OpenRouter-style catalogues list a `pricing` object with dollars per token
 * as strings; anything else carries no price and is ignored.
 */
export function recordPublishedPrices(provider: string, models: { id: string; pricing?: unknown }[]): void {
  for (const model of models) {
    const pricing = model.pricing as { prompt?: unknown; completion?: unknown } | undefined
    const input = Number(pricing?.prompt)
    const output = Number(pricing?.completion)
    if (pricing === undefined || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue
    published.set(key(provider, model.id), { input: input * 1_000_000, output: output * 1_000_000 })
  }
}

/** A price typed in Settings for a model id, or null to go back to the others. */
export function setCustomPrice(model: string, price: ModelPrice | null): void {
  const id = model.trim()
  if (id === '') throw new Error('Name the model')
  if (price !== null && !valid(price)) throw new Error('Prices are dollars per million tokens, zero or more')
  const next = { ...custom() }
  if (price === null) delete next[id]
  else next[id] = { input: price.input, output: price.output }
  savePersistedSettings({ pricing: next })
}

export function pricedModels(models: ProviderSelection[]): PricedModel[] {
  const seen = new Set<string>()
  const rows: PricedModel[] = []
  for (const entry of models) {
    if (entry.model === '' || seen.has(key(entry.provider, entry.model))) continue
    seen.add(key(entry.provider, entry.model))
    rows.push({ provider: entry.provider, model: entry.model, ...priceFor(entry.provider, entry.model) })
  }
  return rows
}

/** For tests: forget what gateways published. */
export function resetPublishedPrices(): void {
  published.clear()
}
