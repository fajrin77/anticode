import { describe, expect, it } from 'vitest'
import { historyBudgetFor, maxOutputFor } from './loop'
import { contextWindowFor } from '@shared/ipc'

describe('historyBudgetFor', () => {
  it('keeps the shared default for models with an unknown window', () => {
    expect(historyBudgetFor('some-future-model-xyz')).toBe(100_000)
    expect(historyBudgetFor('')).toBe(100_000)
  })

  it('lets a big-window model carry more before compaction', () => {
    // 1M window minus reply headroom
    expect(historyBudgetFor('gemini-2.5-pro')).toBe(976_000)
    // 200k window, still above the default
    expect(historyBudgetFor('glm-5.3-flash')).toBe(176_000)
  })

  it('covers the first-party families instead of the 100k floor', () => {
    // Claude 200k window
    expect(historyBudgetFor('claude-sonnet-4-5')).toBe(176_000)
    expect(historyBudgetFor('claude-opus-4-5')).toBe(176_000)
    expect(historyBudgetFor('claude-sonnet-5')).toBe(176_000)
    // GPT-5 family 400k window
    expect(historyBudgetFor('gpt-5.5')).toBe(376_000)
    expect(historyBudgetFor('gpt-5.4')).toBe(376_000)
    expect(historyBudgetFor('gpt-5-codex')).toBe(376_000)
  })

  it('survives gateway prefixes, dates, and variant suffixes', () => {
    expect(historyBudgetFor('cline-pass/glm-5.3-flash')).toBe(176_000)
    expect(historyBudgetFor('claude-sonnet-4-5-20250929')).toBe(176_000)
    expect(historyBudgetFor('gpt-5.5:latest')).toBe(376_000)
    expect(historyBudgetFor('gemini-2.5-pro-latest')).toBe(976_000)
    expect(contextWindowFor('cline-pass/glm-5.3-flash')).toBe(200_000)
  })

  it('never drops below the shared default', () => {
    expect(historyBudgetFor('glm-4.5')).toBe(104_000)
    expect(historyBudgetFor('gpt-4o')).toBe(104_000)
  })
})

describe('maxOutputFor', () => {
  it('allows a full reply on large families', () => {
    expect(maxOutputFor('claude-sonnet-4-5')).toBe(32_000)
    expect(maxOutputFor('gpt-5.5')).toBe(32_000)
    expect(maxOutputFor('gemini-2.5-pro')).toBe(32_000)
  })

  it('stays inside what small endpoints accept', () => {
    expect(maxOutputFor('gpt-4o')).toBe(16_000)
    expect(maxOutputFor('glm-4.5')).toBe(16_000)
    expect(maxOutputFor('unknown-local-model')).toBe(16_000)
  })
})
