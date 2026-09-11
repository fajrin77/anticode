import { beforeEach, describe, expect, it, vi } from 'vitest'

const saved: { pricing?: Record<string, { input: number; output: number }> } = {}
vi.mock('./settings', () => ({
  loadPersistedSettings: () => saved,
  savePersistedSettings: (patch: typeof saved) => Object.assign(saved, patch)
}))

import { costOf, familyOf, priceFor, recordPublishedPrices, resetPublishedPrices, setCustomPrice } from './pricing'

beforeEach(() => {
  delete saved.pricing
  resetPublishedPrices()
})

describe('model prices', () => {
  it('reads a model the way the built-in list spells it', () => {
    expect(familyOf('anthropic/claude-opus-4.8')).toBe('claude-opus-4-8')
    expect(familyOf('claude-sonnet-4-6-20260101')).toBe('claude-sonnet-4-6')
    expect(familyOf('cline-pass/claude-fable-5-1:beta')).toBe('claude-fable-5-1')
  })

  it("knows Anthropic's published rates, the longest name first", () => {
    expect(priceFor('anthropic', 'claude-opus-5')).toEqual({ price: { input: 5, output: 25 }, source: 'built-in' })
    expect(priceFor('clinepass', 'anthropic/claude-fable-5-1')).toEqual({ price: { input: 10, output: 50 }, source: 'built-in' })
    expect(priceFor('clinepass', 'anthropic/claude-sonnet-5')).toMatchObject({ price: { input: 2, output: 10 } })
  })

  it('never guesses a price it does not know, and a free tier is free', () => {
    expect(priceFor('custom:x', 'mystery-model')).toEqual({ price: null, source: 'unknown' })
    expect(costOf('custom:x', 'mystery-model', 1000, 1000)).toBeNull()
    expect(priceFor('clinepass', 'thinkingmachines/inkling-small:free')).toEqual({ price: { input: 0, output: 0 }, source: 'free' })
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
