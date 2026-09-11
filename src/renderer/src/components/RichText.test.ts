import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { RichText } from './RichText'

const html = (text: string): string => renderToStaticMarkup(createElement(RichText, { text }))

it('keeps a blank line as a gap, but not after a heading', () => {
  const out = html('Selesai:\n\n## Yang dilakukan\n\n- satu')
  expect(out.match(/class="h-2\.5"/g)?.length).toBe(1)
  expect(out).toContain('text-[17.5px]')
})

it('sizes headings by level', () => {
  expect(html('# A')).toContain('text-[20px]')
  expect(html('## A')).toContain('text-[17.5px]')
  expect(html('#### A')).toContain('text-[15.5px]')
})

it('renders code inside bold as a chip, not literal backticks', () => {
  const out = html('- **`vercel.json` (root)** — ditambah')
  expect(out).toContain('<strong')
  expect(out).toMatch(/<code[^>]*>vercel\.json<\/code>/)
  expect(out).not.toContain('`')
})

it('indents nested bullets and hangs numbered items from their number', () => {
  const out = html('1. **Satu**\n   - sub\n2. Dua')
  expect(out).toContain('padding-left:24px')
  expect(out).toMatch(/tabular-nums[^>]*>1\.<\/span>/)
  expect(out).toMatch(/tabular-nums[^>]*>2\.<\/span>/)
})

it('reads a markdown link as its label', () => {
  const out = html('Lihat [RichText.tsx](src/renderer/src/components/RichText.tsx:42)')
  expect(out).toContain('title="src/renderer/src/components/RichText.tsx:42"')
  expect(out).toContain('>RichText.tsx</span>')
  expect(out).not.toContain('](')
})

it('draws task boxes and horizontal rules', () => {
  const out = html('- [x] Deploy\n- [ ] Split\n\n---')
  expect(out).toContain('✅')
  expect(out).toContain('☐')
  expect(out).toContain('border-t')
})
