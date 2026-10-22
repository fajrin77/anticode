import { describe, expect, it } from 'vitest'
import { splitQuote } from './SessionView'

describe('splitQuote', () => {
  it('separates a leading quote from the reply', () => {
    expect(splitQuote('> a\n> b\n\nberarti?')).toEqual({ quote: 'a\nb', body: 'berarti?' })
  })
  it('leaves plain text and mid-text quotes alone', () => {
    expect(splitQuote('halo\n> x')).toEqual({ quote: '', body: 'halo\n> x' })
  })
})
