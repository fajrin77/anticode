import { describe, expect, it } from 'vitest'
import type { UsageRecord } from '@shared/ipc'
import { LIVE_WINDOW_MS, accountTitle, routingNodes } from './LiveRouting'

const row = (provider: string, ts: number, tokens = 10, model = 'm'): UsageRecord => ({
  ts, sessionId: 's', runId: 'r', provider, providerLabel: provider.toUpperCase(), model,
  inputTokens: tokens, outputTokens: 0, cachedTokens: 0, costUsd: null, estimated: false, subagent: false
})

describe('routingNodes', () => {
  it('groups by provider and lights only the one with a fresh request', () => {
    const now = 1_000_000
    const nodes = routingNodes([row('a', now - 1000, 5, 'x'), row('a', now - 90_000), row('b', now - LIVE_WINDOW_MS - 1)], now)
    expect(nodes.map((node) => [node.id, node.live, node.requests])).toEqual([['a', true, 2], ['b', false, 1]])
    expect(nodes[0]?.model).toBe('x')
    expect(nodes[0]?.tokens).toBe(15)
  })

  it('names the account behind a node so same-provider accounts differ', () => {
    const base = { id: 'auth:claude-2', kind: 'claude' as const, label: 'Claude', refreshable: true, createdAt: 1, usable: true }
    expect(accountTitle({ id: 'auth:claude-2', label: 'claude' }, { ...base, account: 'dev@example.com' })).toBe('Claude · dev@example.com')
    expect(accountTitle({ id: 'auth:claude-2', label: 'claude' }, base)).toBe('Claude')
    expect(accountTitle({ id: 'custom:x', label: 'X' }, undefined)).toBe('X')
  })

  it('is empty without requests', () => {
    expect(routingNodes([], 1)).toEqual([])
  })
})
