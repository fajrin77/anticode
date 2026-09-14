import { describe, expect, it } from 'vitest'
import { historyBudgetFor } from './loop'

describe('historyBudgetFor', () => {
  it('keeps the shared default for models with an unknown window', () => {
    expect(historyBudgetFor('claude-sonnet-4-5')).toBe(100_000)
    expect(historyBudgetFor('')).toBe(100_000)
  })

  it('lets a big-window model carry more before compaction', () => {
    // 1M window minus reply headroom
    expect(historyBudgetFor('gemini-2.5-pro')).toBe(976_000)
    // 200k window, still above the default
    expect(historyBudgetFor('glm-5.3-flash')).toBe(176_000)
  })

  it('never drops below the shared default', () => {
    expect(historyBudgetFor('glm-4.5')).toBe(104_000)
  })
})
