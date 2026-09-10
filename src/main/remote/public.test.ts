import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { SESSION_COLOURS } from '@shared/ipc'
import { CONTINUE_PROMPT, FOLLOW_UP_LABEL, PAUSE_LABEL, RESUME_LABEL } from '../../renderer/src/labels'

/**
 * The phone page is a static file that cannot import the desktop's modules, so
 * it carries literal copies. These are what keep the copies honest: the two
 * viewers must paint a session the same colour and say the same words.
 */
const page = readFileSync(path.join(import.meta.dirname, 'public/index.html'), 'utf8')

function constant(name: string): string {
  const match = new RegExp(`const ${name} = '([^']*)';`).exec(page)
  if (match === null) throw new Error(`${name} is missing from the phone page`)
  return match[1] ?? ''
}

it('paints sessions with the desktop palette', () => {
  const literal = /const BADGE_COLOURS = (\[[\s\S]*?\]);/.exec(page)?.[1]
  expect(literal).toBeDefined()
  const palette = JSON.parse((literal ?? '[]').replace(/'/g, '"')) as unknown
  expect(palette).toEqual(SESSION_COLOURS)
})

it("speaks the desktop's words", () => {
  expect(constant('PAUSE_LABEL')).toBe(PAUSE_LABEL)
  expect(constant('RESUME_LABEL')).toBe(RESUME_LABEL)
  expect(constant('FOLLOW_UP_LABEL')).toBe(FOLLOW_UP_LABEL)
  expect(constant('CONTINUE_PROMPT')).toBe(CONTINUE_PROMPT)
})
