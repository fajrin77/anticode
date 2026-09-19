import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: (): string => '/tmp/anticode-usage-test' }
}))

import { clearUsage, recentUsage, recordUsage, setUsageLogFileForTests, summarizeUsage } from './usageLog'
import type { UsageRecord } from '@shared/ipc'

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: Date.now(),
    sessionId: 's1',
    runId: 'r1',
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 20,
    cachedTokens: 10,
    costUsd: 0.001,
    estimated: false,
    subagent: false,
    ...overrides
  }
}

beforeEach(() => {
  setUsageLogFileForTests(path.join(mkdtempSync(path.join(tmpdir(), 'anticode-usage-')), 'usage.jsonl'))
})

describe('usageLog', () => {
  it('aggregates totals, days, and models from real rows', () => {
    recordUsage(record({ model: 'claude-sonnet-4-5', inputTokens: 100, outputTokens: 20, cachedTokens: 10, costUsd: 0.001 }))
    recordUsage(record({ model: 'gpt-5.5', provider: 'codex', providerLabel: 'ChatGPT', inputTokens: 200, outputTokens: 40, cachedTokens: 0, costUsd: 0.002 }))
    const summary = summarizeUsage(null)
    expect(summary.requests).toBe(2)
    expect(summary.inputTokens).toBe(300)
    expect(summary.cachedTokens).toBe(10)
    expect(summary.outputTokens).toBe(60)
    expect(summary.costUsd).toBeCloseTo(0.003)
    expect(summary.byModel).toHaveLength(2)
    expect(summary.byDay).toHaveLength(1)
  })

  it('filters by time range', () => {
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000
    recordUsage(record({ ts: old, inputTokens: 500 }))
    recordUsage(record({ inputTokens: 100 }))
    expect(summarizeUsage(7 * 24 * 60 * 60 * 1000).requests).toBe(1)
    expect(summarizeUsage(null).requests).toBe(2)
  })

  it('marks cost partial when a model has no price', () => {
    recordUsage(record({ costUsd: null }))
    const summary = summarizeUsage(null)
    expect(summary.costPartial).toBe(true)
    expect(summary.byModel[0]?.costPartial).toBe(true)
  })

  it('lists recent newest-first and clears the log', () => {
    recordUsage(record({ runId: 'r1', model: 'm1' }))
    recordUsage(record({ runId: 'r2', model: 'm2' }))
    expect(recentUsage(10).map((row) => row.model)).toEqual(['m2', 'm1'])
    expect(clearUsage()).toBe(2)
    expect(summarizeUsage(null).requests).toBe(0)
  })
})
