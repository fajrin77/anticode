import { expect, it } from 'vitest'
import { usageModelTotals } from './usageModelTotals'

it('totals the same model across accounts without mutating source rows', () => {
  const rows = [
    { model: 'poolside/laguna-xs-2.1:free', inputTokens: 60_000_000, cachedTokens: 20, outputTokens: 30 },
    { model: 'poolside/laguna-xs-2.1:free', inputTokens: 40_000_000, cachedTokens: 40, outputTokens: 50 },
    { model: 'other', inputTokens: 1, cachedTokens: 0, outputTokens: 2 }
  ]
  expect(usageModelTotals(rows)).toEqual([
    { model: rows[0]!.model, inputTokens: 100_000_000, cachedTokens: 60, outputTokens: 80 },
    rows[2]
  ])
  expect(rows[0]!.inputTokens).toBe(60_000_000)
  expect(usageModelTotals([])).toEqual([])
})
