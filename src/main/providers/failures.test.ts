import { expect, it } from 'vitest'
import { canFailOver, canRotateAfterRefusal, isTransient } from './failures'

it('allows a generic inference 403 only for explicit pool rotation, not transient retry', () => {
  const error = { cause: { statusCode: 403 }, message: 'Forbidden' }
  expect(canRotateAfterRefusal(error)).toBe(true)
  expect(canFailOver(error)).toBe(false)
  expect(isTransient(error)).toBe(false)
  expect(canRotateAfterRefusal({ status: 400 })).toBe(false)
})

it.each([401, 402, 408, 429, 500, 503])('allows failover for HTTP %s', (status) => {
  expect(canFailOver({ cause: { statusCode: status } })).toBe(true)
})
it.each([400, 403, 404, 422])('does not fail over permanent HTTP %s even when the message mentions network', (status) => {
  const error = { status, message: 'network model unsupported' }
  expect(isTransient(error)).toBe(false)
  expect(canFailOver(error)).toBe(false)
})
it('recognizes nested transport errors and explicit quota refusals', () => {
  expect(canFailOver(new Error('request failed', { cause: { code: 'ENETUNREACH' } }))).toBe(true)
  expect(canFailOver({ status: 403, message: 'monthly quota exhausted' })).toBe(true)
})
