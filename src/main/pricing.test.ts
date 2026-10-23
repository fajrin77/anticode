import { beforeEach, describe, expect, it, vi } from 'vitest'

const saved: { pricing?: Record<string, { input: number; output: number }> } = {}
vi.mock('./settings', () => ({
  loadPersistedSettings: () => saved,
  savePersistedSettings: (patch: typeof saved) => Object.assign(saved, patch)
}))

import {
  costOf,
  familyOf,
  listedContextWindow,
  priceFor,
  publishedContextWindow,
  recordPublishedContexts,
  recordPublishedPrices,
  resetPublishedContexts,
  resetPublishedPrices,
  setCustomPrice
} from './pricing'

beforeEach(() => {
  delete saved.pricing
  resetPublishedPrices()
  resetPublishedContexts()
})

describe('model prices', () => {
  it('reads a model the way the built-in list spells it', () => {
    expect(familyOf('anthropic/claude-opus-4.8')).toBe('claude-opus-4-8')
    expect(familyOf('claude-sonnet-4-6-20260101')).toBe('claude-sonnet-4-6')
    expect(familyOf('cline-pass/claude-fable-5-1:beta')).toBe('claude-fable-5-1')
  })

  it("knows Anthropic's published rates, the longest name first", () => {
    expect(priceFor('anthropic', 'claude-opus-5')).toEqual({ price: { input: 5, output: 25 }, source: 'built-in' })
    expect(priceFor('custom:gateway', 'anthropic/claude-fable-5-1')).toEqual({ price: { input: 10, output: 50 }, source: 'built-in' })
    expect(priceFor('custom:gateway', 'anthropic/claude-sonnet-5')).toMatchObject({ price: { input: 2, output: 10 } })
  })

  it('never guesses a price it does not know, and a free tier is free', () => {
    expect(priceFor('custom:x', 'mystery-model')).toEqual({ price: null, source: 'unknown' })
    expect(costOf('custom:x', 'mystery-model', 1000, 1000)).toBeNull()
    expect(priceFor('custom:gateway', 'thinkingmachines/inkling-small:free')).toEqual({ price: { input: 0, output: 0 }, source: 'free' })
  })

  it('takes a gateway price over the built-in one, and a typed one over both', () => {
    recordPublishedPrices('custom:or', [{ id: 'anthropic/claude-opus-5', pricing: { prompt: '0.000004', completion: '0.00002' } }, { id: 'no-price' }])
    expect(priceFor('custom:or', 'anthropic/claude-opus-5')).toEqual({ price: { input: 4, output: 20 }, source: 'gateway' })
    setCustomPrice('anthropic/claude-opus-5', { input: 1, output: 2 })
    expect(priceFor('custom:or', 'anthropic/claude-opus-5')).toEqual({ price: { input: 1, output: 2 }, source: 'custom' })
    setCustomPrice('anthropic/claude-opus-5', null)
    expect(priceFor('custom:or', 'anthropic/claude-opus-5').source).toBe('gateway')
  })

  it('prices a request in dollars', () => {
    expect(costOf('anthropic', 'claude-opus-5', 1_000_000, 100_000)).toBeCloseTo(7.5)
    expect(() => setCustomPrice('m', { input: -1, output: 1 })).toThrow(/zero or more/)
  })
})

it('keeps subscription token usage separate from per-token API estimates', () => {
  setCustomPrice('claude-opus-5', { input: 99, output: 99 })
  for (const provider of ['clinepass', 'auth:codex']) {
    expect(priceFor(provider, 'claude-opus-5')).toEqual({ price: null, source: 'subscription' })
    expect(costOf(provider, 'claude-opus-5', 1000, 1000)).toBeNull()
  }
})

describe('published context windows', () => {
  it('keeps what a gateway listed for its ids, per provider', () => {
    // Parsed rather than trusted: a gateway that sends a string is still right.
    const listed: { id: string; context_length?: unknown }[] = [{ id: 'minimax/minimax-m3.1-flash', context_length: '1000000' }, { id: 'no-window' }]
    recordPublishedContexts('custom:or', listed)
    expect(publishedContextWindow('custom:or', 'minimax/minimax-m3.1-flash')).toBe(1_000_000)
    expect(publishedContextWindow('custom:other', 'minimax/minimax-m3.1-flash')).toBeNull()
    expect(publishedContextWindow('custom:or', 'no-window')).toBeNull()
  })

  it('ignores a value that is not a positive number instead of guessing', () => {
    const listed: { id: string; context_length?: unknown }[] = [
      { id: 'empty', context_length: '' },
      { id: 'blank', context_length: '   ' },
      { id: 'zero', context_length: 0 },
      { id: 'text', context_length: 'huge' },
      { id: 'negative', context_length: -5 }
    ]
    recordPublishedContexts('custom:or', listed)
    for (const model of ['empty', 'blank', 'zero', 'text', 'negative']) expect(publishedContextWindow('custom:or', model)).toBeNull()
  })

  it('finds the window again by model id alone, for the UI that has no provider', () => {
    recordPublishedContexts('custom:or', [{ id: 'deepseek/deepseek-v4.1-flash', context_length: 1_048_576 }])
    expect(listedContextWindow('deepseek/deepseek-v4.1-flash')).toBe(1_048_576)
    expect(listedContextWindow('unknown-model')).toBeNull()
  })
})
