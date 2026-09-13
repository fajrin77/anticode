import { describe, expect, it } from 'vitest'
import { isOutOfUsage } from './usageErrors'

describe('isOutOfUsage', () => {
  it.each([
    ['a monthly gateway plan', { status: 429, message: 'You have reached your monthly plan limit. It resets in 15d 18h.' }],
    ['OpenAI-style quota', { status: 429, error: { code: 'insufficient_quota', message: 'You exceeded your current quota.' } }],
    ['Anthropic-style balance', { status: 400, error: { message: 'Your credit balance is too low to access the API.' } }],
    ['OpenRouter-style credits', { status: 402, message: 'Insufficient credits' }],
    ['an OpenAI-compatible spending cap', { status: 429, message: 'Organization spending limit reached.' }],
    ['a nested SDK cause', { cause: { cause: { statusCode: 402, message: 'Payment Required' } } }]
  ])('recognises spent usage from %s', (_providerShape, error) => {
    expect(isOutOfUsage(error)).toBe(true)
  })

  it.each([
    { status: 429, message: 'Rate limit reached. Retry in 30 seconds.' },
    { status: 429, message: 'Too many requests per minute.' },
    { status: 503, message: 'The provider is temporarily overloaded.' },
    { status: 401, message: 'Invalid API key.' }
  ])('does not classify a temporary or configuration error as spent quota', (error) => {
    expect(isOutOfUsage(error)).toBe(false)
  })
})
