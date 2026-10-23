import { describe, expect, it } from 'vitest'
import { agentHistoryBudget, historyBudgetFor, maxOutputFor } from './loop'
import { contextWindowFor } from '@shared/ipc'
import { recordPublishedContexts, resetPublishedContexts } from '../pricing'

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

  it('believes the window a provider published over the family table', () => {
    // A model the table has never heard of would keep the 100k floor.
    expect(historyBudgetFor('minimax/minimax-m3.1-flash')).toBe(100_000)
    expect(historyBudgetFor('minimax/minimax-m3.1-flash', 1_000_000)).toBe(976_000)
    // A known family still follows the provider that says it is smaller.
    expect(historyBudgetFor('gpt-5.5', 128_000)).toBe(104_000)
  })

  it('ignores a published value that is not a usable window', () => {
    expect(historyBudgetFor('glm-5.3-flash', 0)).toBe(176_000)
    expect(historyBudgetFor('glm-5.3-flash', null)).toBe(176_000)
    expect(historyBudgetFor('glm-5.3-flash', Number.NaN)).toBe(176_000)
  })
})

describe('agentHistoryBudget', () => {
  it('takes the window the provider published for the exact id', () => {
    resetPublishedContexts()
    recordPublishedContexts('custom:or', [{ id: 'minimax/minimax-m3.1-flash', context_length: 1_000_000 }])
    expect(agentHistoryBudget({ id: 'custom:or', model: 'minimax/minimax-m3.1-flash' })).toBe(976_000)
    // Another provider serving the same id is measured by the family table.
    expect(agentHistoryBudget({ id: 'auth:cline', model: 'minimax/minimax-m3.1-flash' })).toBe(100_000)
    resetPublishedContexts()
  })

  it('falls back to the family table when nothing was published', () => {
    resetPublishedContexts()
    expect(agentHistoryBudget({ id: 'custom:or', model: 'glm-5.3-flash' })).toBe(176_000)
    expect(agentHistoryBudget({ model: 'glm-5.3-flash' })).toBe(176_000)
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
