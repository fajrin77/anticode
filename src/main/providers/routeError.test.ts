import { expect, it } from 'vitest'
import { isRetiredRoute, RetiredRouteError } from './routeError'
import { safeProviderErrorMessage } from './errorMessage'

it('recognizes primary retirement inside a wrapped SSE 404 and hides pricing/account metadata', () => {
  const error = Object.assign(new Error('Failed to create stream: status 404: ' + JSON.stringify({ error: { code: 404, message: 'The :free variant has been retired; use paid/model instead ($1/M).' }, user_id: 'private-org' })), { status: 404 })
  expect(isRetiredRoute(error)).toBe(true)
  const display = safeProviderErrorMessage(error, 'minimax/model:free')
  expect(display).toContain('sudah dihentikan')
  for (const raw of ['private-org', 'user_id', 'paid/model', '$1/M', '{']) expect(display).not.toContain(raw)
})

it.each([
  { status: 404, message: 'Unknown endpoint' },
  { status: 403, message: 'This model is only available via official product surfaces' },
  { status: 503, message: 'Model temporarily unavailable' },
  { status: 404, message: JSON.stringify({ error: { message: 'Unknown endpoint', metadata: { previous_errors: [{ code: 404, message: 'The old model was retired' }] } } }) }
])('does not infer retirement from missing endpoints or historic metadata: %j', error => {
  expect(isRetiredRoute(error)).toBe(false)
})

it('accepts explicit retirement for dotted model ids and its normalized error', () => {
  expect(isRetiredRoute({ status: 410, message: 'Model minimax/m3.1-flash has been retired.' })).toBe(true)
  expect(isRetiredRoute(new RetiredRouteError('exact:free'))).toBe(true)
})

it('never echoes JSON or account metadata for an ordinary provider refusal', () => {
  const message = safeProviderErrorMessage(Object.assign(new Error('HTTP 403: {"error":{"message":"Forbidden"},"user_id":"private-account"}'), { status: 403 }))
  expect(message).toContain('HTTP 403')
  expect(message).toContain('tidak dicoba berulang')
  expect(message).not.toMatch(/private-account|user_id|\{|Forbidden/)
  expect(safeProviderErrorMessage(new Error('Invalid key sk-private-key'))).not.toContain('sk-private')
})

it('explains payload limits without echoing upsell links or upstream metadata', () => {
  const message = safeProviderErrorMessage(Object.assign(new Error('413 This request is larger than 4 MB. Top up at https://example.com/dashboard'), { status: 413 }))
  expect(message).toContain('HTTP 413')
  expect(message).toContain('tetap tersimpan')
  expect(message).not.toMatch(/example.com|Top up/)
})
