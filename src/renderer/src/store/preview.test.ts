import { beforeEach, expect, it } from 'vitest'
import { usePreviewStore } from './preview'

beforeEach(() => usePreviewStore.getState().close())

it('toggles the same artifact and opens a different file or session', () => {
  const file = { kind: 'artifact' as const, sessionId: 'a', path: 'file.txt' }
  const { open } = usePreviewStore.getState()
  open(file)
  expect(usePreviewStore.getState().target).toEqual(file)
  open(file)
  expect(usePreviewStore.getState().target).toBeNull()
  open(file)
  open({ ...file, sessionId: 'b' })
  expect(usePreviewStore.getState().target).toEqual({ ...file, sessionId: 'b' })
  open({ ...file, path: 'other.txt' })
  expect(usePreviewStore.getState().target?.path).toBe('other.txt')
})

it('toggles an attachment by its path', () => {
  const file = { kind: 'attachment' as const, path: '/file.txt', name: 'file.txt' }
  usePreviewStore.getState().open(file)
  usePreviewStore.getState().open(file)
  expect(usePreviewStore.getState().target).toBeNull()
})
