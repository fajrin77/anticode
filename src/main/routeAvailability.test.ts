import { beforeEach, expect, it, vi } from 'vitest'
import type { PersistedSettings } from './settings'
const { settings } = vi.hoisted(() => ({ settings: {} as PersistedSettings }))
vi.mock('./settings', () => ({ loadPersistedSettings: () => settings, savePersistedSettings: (patch: PersistedSettings) => Object.assign(settings, patch) }))
import { markRetiredRoute, unavailableRoute } from './routeAvailability'

beforeEach(() => { delete settings.unavailableRoutes })

it('remembers only the exact provider/model, without guessing aliases or marking siblings', () => {
  markRetiredRoute('auth:cline', 'vendor/model:free')
  expect(unavailableRoute('auth:cline', 'vendor/model:free')).toContain('dihentikan')
  expect(unavailableRoute('auth:cline-2', 'vendor/model:free')).toBeNull()
  expect(unavailableRoute('auth:cline', 'vendor/model')).toBeNull()
  expect(unavailableRoute('auth:cline', 'other:free')).toBeNull()
  expect(settings.unavailableRoutes?.['auth:cline']?.['vendor/model:free']?.since).toBeGreaterThan(0)
})

it('holds a retirement across catalogue refreshes and permits a bounded recheck after 24 hours', () => {
  const now = Date.now()
  markRetiredRoute('provider', 'vendor/model:free')
  expect(unavailableRoute('provider', 'vendor/model:free')).not.toBeNull()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60_000 + 1)
  expect(unavailableRoute('provider', 'vendor/model:free')).toBeNull()
  clock.mockRestore()
})
