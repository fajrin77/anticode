import { describe, expect, it } from 'vitest'
import type { UsageRecord } from '@shared/ipc'
import { LIVE_WINDOW_MS, accountTitle, routingNodes, titleParts } from './LiveRouting'

const row = (provider: string, ts: number, tokens = 10, model = 'm'): UsageRecord => ({
  ts, sessionId: 's', runId: 'r', provider, providerLabel: provider.toUpperCase(), model,
  inputTokens: tokens, outputTokens: 0, cachedTokens: 0, costUsd: null, estimated: false, subagent: false
})

describe('routingNodes', () => {
  it('keeps an active run lit after the recent-request window without fabricating usage', () => {
    const nodes = routingNodes([row('a', 1)], 100_000, [{ provider: 'a', model: 'current' }])
    expect(nodes[0]).toMatchObject({ live: true, model: 'current', requests: 1, tokens: 10 })
    expect(routingNodes([row('a', 1)], 100_000)[0]?.live).toBe(false)
  })

  it('shows an active provider before its first usage report', () => {
    expect(routingNodes([], 100_000, [{ provider: 'new', model: 'm' }])[0]).toMatchObject({ id: 'new', live: true, requests: 0, tokens: 0 })
    expect(routingNodes([], 100_000, [{}])).toEqual([])
  })
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

  it('does not repeat the identity already in the label', () => {
    const base = { id: 'auth:claude', kind: 'claude' as const, label: 'Claude · dev@example.com', refreshable: true, createdAt: 1, usable: true }
    expect(accountTitle({ id: 'auth:claude', label: 'claude' }, { ...base, account: 'dev@example.com' })).toBe('Claude · dev@example.com')
  })

  it('splits the name from the identity', () => {
    expect(titleParts('Claude Code · a@b.com')).toEqual({ name: 'Claude Code', who: 'a@b.com' })
    expect(titleParts('X')).toEqual({ name: 'X', who: '' })
  })

  it('lights the account node a run is served by instead of adding an engine-named twin', () => {
    const now = 1_000_000
    const nodes = routingNodes(
      [row('auth:claude-2', now - 60_000, 5, 'claude-opus-5-5'), row('auth:codex', now - 60_000, 5, 'gpt-6.1-sol')],
      now,
      [{ provider: 'claude', model: 'claude-opus-5-5' }]
    )
    expect(nodes).toHaveLength(2)
    expect(nodes[0]).toMatchObject({ id: 'auth:claude-2', live: true, model: 'claude-opus-5-5' })
    expect(nodes[1]).toMatchObject({ id: 'auth:codex', live: false })
  })

  it('is empty without requests', () => {
    expect(routingNodes([], 1)).toEqual([])
  })
})
