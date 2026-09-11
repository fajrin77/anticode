import { expect, it } from 'vitest'
import { cleanModelIds } from './custom'

it('reads model ids typed one per line or comma-separated, first one kept first', () => {
  expect(cleanModelIds('moonshotai/kimi-k3\n qwen/qwen3-coder , \n\nmoonshotai/kimi-k3')).toEqual([
    'moonshotai/kimi-k3',
    'qwen/qwen3-coder'
  ])
  expect(cleanModelIds(['a', ' b ', ''])).toEqual(['a', 'b'])
  expect(cleanModelIds(undefined)).toEqual([])
  expect(cleanModelIds(42)).toEqual([])
})
