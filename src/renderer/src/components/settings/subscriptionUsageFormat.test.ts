import { expect, it } from 'vitest'
import { quotaResetLabel, quotaWindowLabel } from './subscriptionUsageFormat'
it('formats the screenshot countdown without confusing remaining time with a monthly allowance', () => {
  const now = Date.parse('2026-10-22T02:00:00Z')
  expect(quotaResetLabel(now + (3 * 60 + 29) * 60000, now)).toBe('Resets in 3 h 29 min')
  expect(quotaResetLabel(now + 60000, now)).toBe('Resets in 1 min')
  expect(quotaResetLabel(now - 1, now)).toBe('Waiting for the quota to refresh')
  expect(quotaResetLabel(null, now)).toBe('Reset time not available yet')
  expect(quotaWindowLabel('7-day window')).toBe('Weekly · all models')
  expect(quotaWindowLabel('Weekly')).toBe('Weekly')
  expect(quotaWindowLabel('Monthly')).toBe('Monthly')
  expect(quotaResetLabel(Date.parse('2026-11-17T08:21:02Z'), now)).toContain('Nov 17')
  expect(quotaWindowLabel('Secondary window')).toBe('Secondary limit')
})
