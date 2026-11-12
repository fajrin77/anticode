import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

const { assertDeepSeekFreeCredit, freeCreditBlock, parseDeepSeekSummary, platformData, platformPage, platformPayload } = await import('./deepseek')

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

it('names the sign-in step when the Platform reply is empty or not JSON', () => {
  expect(() => platformPayload('/auth-api/v0/dsh/auth_exchange', 200, '')).toThrow(/empty reply/)
  expect(() => platformPayload('/auth-api/v0/dsh/auth_exchange', 200, '  ')).toThrow(/empty reply to auth_exchange \(HTTP 200\)/)
  expect(() => platformPayload('/auth-api/v0/dsh/auth_exchange', 200, '<html>')).toThrow(/unreadable reply to auth_exchange \(HTTP 200\)/)
  expect(platformPayload('/auth-api/v0/dsh/auth_init', 200, '{"code":0}')).toEqual({ code: 0 })
})

const granted = JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: { normal_wallets: [{ currency: 'USD', balance: '0' }], bonus_wallets: [{ currency: 'USD', balance: '2' }] } } })

it('retries the empty 202 the Platform edge sends before giving up', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 202 })))
  try {
    await expect(assertDeepSeekFreeCredit('token-retry', new AbortController().signal)).rejects.toThrow(/empty reply to users\/get_user_summary \(HTTP 202\)/)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('keeps the last verified credit answer while the Platform throttles', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const signal = new AbortController().signal
  const stub = vi.fn(async () => new Response(granted, { status: 200 }))
  vi.stubGlobal('fetch', stub)
  try {
    await assertDeepSeekFreeCredit('token-grace', signal)
    vi.setSystemTime(Date.now() + 60_000)
    stub.mockImplementation(async () => new Response('', { status: 202 }))
    await expect(assertDeepSeekFreeCredit('token-grace', signal)).resolves.toBeUndefined()
    vi.setSystemTime(Date.now() + 16 * 60_000)
    await expect(assertDeepSeekFreeCredit('token-grace', signal)).rejects.toThrow(/HTTP 202/)
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
