import { expect, it } from 'vitest'
import { quotaResetLabel, quotaWindowLabel } from './subscriptionUsageFormat'
it('formats the screenshot countdown without confusing remaining time with a monthly allowance', () => {
  const now = Date.parse('2026-10-22T02:00:00Z')
  expect(quotaResetLabel(now + (3 * 60 + 29) * 60000, now)).toBe('Reset dalam 3 jam 29 menit')
  expect(quotaResetLabel(now + 60000, now)).toBe('Reset dalam 1 menit')
  expect(quotaResetLabel(now - 1, now)).toBe('Menunggu pembaruan kuota')
  expect(quotaResetLabel(null, now)).toBe('Waktu reset belum tersedia')
  expect(quotaWindowLabel('7-day window')).toBe('Mingguan · semua model')
  expect(quotaWindowLabel('Weekly')).toBe('Mingguan')
  expect(quotaWindowLabel('Monthly')).toBe('Bulanan')
  expect(quotaResetLabel(Date.parse('2026-11-17T08:21:02Z'), now)).toContain('17 Nov')
  expect(quotaWindowLabel('Secondary window')).toBe('Batas tambahan')
})
