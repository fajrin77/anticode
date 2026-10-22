import { beforeEach, expect, it, vi } from 'vitest'
const { settings } = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }))
vi.mock('../settings', () => ({ loadPersistedSettings: () => settings, savePersistedSettings: (patch: object) => Object.assign(settings, patch) }))
import { composerProviders, setComposerVisibility, setComposerGroupVisibility } from './visibility'
beforeEach(() => { for (const key of Object.keys(settings)) delete settings[key] })

it('migrates only the previous selection, and never auto-enables newly selected or registered providers', () => {
  settings.provider = 'auth:cline'
  expect(composerProviders()).toEqual({ 'auth:cline': true })
  settings.provider = 'auth:codex-2'
  expect(composerProviders()).toEqual({ 'auth:cline': true })
})
it('keeps an explicitly empty composer empty and persists independent account choices', () => {
  settings.composerProviders = {}
  settings.provider = 'auth:cline'
  expect(composerProviders()).toEqual({})
  setComposerVisibility('auth:cline', true)
  setComposerVisibility('auth:cline-2', true)
  setComposerVisibility('auth:cline', false)
  expect(composerProviders()).toEqual({ 'auth:cline': false, 'auth:cline-2': true })
})
it('starts a fresh profile with every provider hidden without affecting credentials or rotation', () => {
  settings.rotation = { enabled: true, entries: [{ provider: 'auth:cline', model: 'free' }] }
  const rotation = structuredClone(settings.rotation)
  expect(composerProviders()).toEqual({})
  setComposerVisibility('auth:cline', true)
  expect(settings.rotation).toEqual(rotation)
  setComposerVisibility('auth:cline', false)
  expect(settings.rotation).toEqual(rotation)
})

it('changes a whole service together and retains individual overrides and other services', () => {
  setComposerVisibility('auth:claude', true)
  const ids = Array.from({ length: 5 }, (_, i) => `auth:cline-${i}`)
  setComposerGroupVisibility(ids, true)
  expect(ids.every(id => composerProviders()[id])).toBe(true)
  setComposerVisibility(ids[0]!, false)
  expect(ids.filter(id => composerProviders()[id])).toHaveLength(4)
  setComposerGroupVisibility(ids, false)
  expect(ids.every(id => composerProviders()[id] === false)).toBe(true)
  expect(composerProviders()['auth:claude']).toBe(true)
  setComposerGroupVisibility(ids, true)
  expect(ids.every(id => composerProviders()[id])).toBe(true)
})
