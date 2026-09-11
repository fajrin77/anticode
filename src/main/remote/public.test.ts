import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { modelLabel, ROTATE_LABEL, ROTATE_PROVIDER, SESSION_COLOURS } from '@shared/ipc'
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
  expect(constant('ROTATE_LABEL')).toBe(ROTATE_LABEL)
})

/** A top-level function of the phone page, by name, as source. */
function pageFunction(name: string): string {
  const start = page.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} is missing from the phone page`)
  const end = page.indexOf('\n}\n', start)
  return page.slice(start, end + 2)
}

it('labels the model chip as the desktop does, group included', () => {
  const phoneLabel = new Function(
    `const ROTATE = '${ROTATE_PROVIDER}'; const ROTATE_LABEL = '${ROTATE_LABEL}';` +
      pageFunction('activeRotationGroup') + pageFunction('modelLabel') + 'return modelLabel;'
  )() as (info: unknown) => string
  const groups = [{ id: 'g1', name: 'code only', entries: [] }]
  for (const status of [
    { provider: ROTATE_PROVIDER, model: '', lastUsed: null, rotationGroups: groups, rotationGroup: null },
    { provider: ROTATE_PROVIDER, model: '', lastUsed: null, rotationGroups: groups, rotationGroup: 'g1' },
    { provider: ROTATE_PROVIDER, model: '', lastUsed: { provider: 'one', model: 'glm-5.3' }, rotationGroups: groups, rotationGroup: 'g1' },
    { provider: 'one', model: 'glm-5.3', lastUsed: null, rotationGroups: groups, rotationGroup: 'g1' }
  ]) {
    expect(phoneLabel(status)).toBe(modelLabel(status))
  }
})
