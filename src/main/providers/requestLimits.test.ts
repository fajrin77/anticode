import { expect, it } from 'vitest'
import { InputRequestLimitError, requestLimit } from './requestLimits'
import { isOutOfUsage } from '../usageErrors'
import { isTransient } from './failures'

it('separates request size, output allowance, concurrency and exhausted balance', () => {
  const input = Object.assign(new Error('402 Prompt tokens limit exceeded: 79985 > 9785'), { status: 402 })
  expect(requestLimit(new Error('Wrapped', { cause: input }))).toEqual({ kind: 'input', promptTokens: 79985, limitTokens: 9785 })
  expect(isOutOfUsage(input)).toBe(false)
  expect(isTransient(input)).toBe(false)
  const inflight = { status: 402, error: { message: 'This request would exceed your available credits given your current in-flight requests. Retry later.' } }
  expect(isOutOfUsage(inflight)).toBe(false)
  expect(isTransient(inflight)).toBe(true)
  expect(isOutOfUsage({ status: 402, message: 'Insufficient credits' })).toBe(true)
  expect(requestLimit({ message: 'You requested up to 32768 tokens, but can only afford 512' })?.kind).toBe('output')
})

it('retains input allowance through normalized and serialized errors, including both wrapper branches', () => {
  const normalized = new InputRequestLimitError(13114, 4064)
  for (const error of [normalized, new Error(normalized.message), { error: {}, cause: normalized }]) {
    expect(requestLimit(error)).toEqual({ kind: 'input', promptTokens: 13114, limitTokens: 4064 })
    expect(isOutOfUsage(error)).toBe(false)
    expect(isTransient(error)).toBe(false)
  }
})
