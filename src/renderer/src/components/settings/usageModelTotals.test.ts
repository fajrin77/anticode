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

it('ranks aggregated models by total input and output without double-counting cache', () => {
  const rows = [
    { model: 'small', inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
    { model: 'combined', inputTokens: 60, cachedTokens: 0, outputTokens: 0 },
    { model: 'cached', inputTokens: 100, cachedTokens: 100, outputTokens: 0 },
    { model: 'output-heavy', inputTokens: 20, cachedTokens: 0, outputTokens: 120 },
    { model: 'combined', inputTokens: 90, cachedTokens: 0, outputTokens: 0 }
  ]
  expect(usageModelTotals(rows).map(row => row.model)).toEqual([
    'combined', 'output-heavy', 'cached', 'small'
  ])
  expect(rows.map(row => row.model)).toEqual(['small', 'combined', 'cached', 'output-heavy', 'combined'])
})

it('preserves original order for equal totals and keeps different aliases separate', () => {
  expect(usageModelTotals([
    { model: 'alias-b', inputTokens: 5, cachedTokens: 5, outputTokens: 5 },
    { model: 'alias-a', inputTokens: 10, cachedTokens: 0, outputTokens: 0 }
  ]).map(row => row.model)).toEqual(['alias-b', 'alias-a'])
})
