import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

const { freeCreditBlock, parseDeepSeekSummary, platformData, platformPage } = await import('./deepseek')

it('allows only granted credit with every top-up wallet empty', () => {
  expect(freeCreditBlock(parseDeepSeekSummary({ normal_wallets: [{ currency: 'USD', balance: '0' }], bonus_wallets: [{ currency: 'USD', balance: '5.00' }] }))).toBeNull()
  expect(freeCreditBlock(parseDeepSeekSummary({ normal_wallets: [], bonus_wallets: [{ currency: 'CNY', balance: '0E-16' }, { currency: 'USD', balance: '1e+0' }] }))).toBeNull()
})

it('refuses a turn that could be charged to top-up balance or has no granted credit', () => {
  expect(freeCreditBlock(parseDeepSeekSummary({ normal_wallets: [{ currency: 'USD', balance: '2.5' }], bonus_wallets: [{ currency: 'USD', balance: '5' }] }))).toMatch(/top-up balance \(2.5 USD\)/)
  expect(freeCreditBlock(parseDeepSeekSummary({ normal_wallets: [{ currency: 'USD', balance: '0.00' }], bonus_wallets: [{ currency: 'USD', balance: '0.00' }] }))).toMatch(/no granted credit/)
})

it('treats an unreadable wallet as an error, never as zero', () => {
  expect(() => parseDeepSeekSummary({ normal_wallets: [{ currency: 'USD', balance: 'n/a' }], bonus_wallets: [] })).toThrow(/unreadable/)
  expect(() => parseDeepSeekSummary({ bonus_wallets: [] })).toThrow(/no wallet list/)
})

it('unwraps the Platform envelope and maps code 40003 to a dead login', () => {
  expect(platformData({ code: 0, data: { biz_code: 0, biz_data: { ok: 1 } } })).toEqual({ ok: 1 })
  expect(() => platformData({ code: 0, data: { biz_code: 7, biz_data: null } })).toThrow(/refused/)
  expect(() => platformData({ code: 40003 })).toThrow(expect.objectContaining({ status: 401, scope: 'account' }))
})

it('opens only Platform pages on the expected path', () => {
  expect(platformPage('https://platform.deepseek.com/dsh/authorize?id=1', '/dsh/authorize')).toBe('https://platform.deepseek.com/dsh/authorize?id=1')
  expect(() => platformPage('https://evil.example/dsh/authorize', '/dsh/authorize')).toThrow()
  expect(() => platformPage('https://platform.deepseek.com/other', '/dsh/authorize')).toThrow()
})
