import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { AttachmentInfo } from '@shared/ipc'

const item = (id: string): AttachmentInfo => ({ id, name: `${id}.txt`, path: `/fixture/${id}.txt`, kind: 'text', size: 3, thumbnail: null, workspacePath: null } as AttachmentInfo)
let module: typeof import('./draftAttachments')
let store: typeof import('./store/session')['useSessionStore']
const api = { addAttachments: vi.fn(), releaseAttachments: vi.fn().mockResolvedValue(undefined) }
beforeEach(async () => {
  vi.resetModules()
  vi.unstubAllGlobals()
  store = (await import('./store/session')).useSessionStore
  module = await import('./draftAttachments')
  vi.stubGlobal('window', { anticode: api })
  api.addAttachments.mockReset()
  api.releaseAttachments.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

it('tracks work per session and preserves good files when another fails', async () => {
  const id = store.getState().openSession('chat', null)
  let complete!: (items: AttachmentInfo[]) => void
  const slow = new Promise<AttachmentInfo[]>(resolve => { complete = resolve })
  const work = module.stageDraftAttachments(id, [() => slow, async () => { throw new Error('bad.xlsx cannot be read') }])
  expect(module.useAttachmentJobs.getState().pending[id]).toBe(2)
  await Promise.resolve()
  const other = store.getState().openSession('chat', null)
  complete([item('good')])
  await work
  expect(store.getState().drafts[id]?.attachments.map(a => a.id)).toEqual(['good'])
  expect(store.getState().drafts[id]?.attachmentErrors).toEqual(['bad.xlsx cannot be read'])
  expect(store.getState().drafts[other]?.attachments ?? []).toEqual([])
  expect(module.useAttachmentJobs.getState().pending[id]).toBe(0)
})

it('releases late uploads when their session was deleted', async () => {
  const id = store.getState().openSession('chat', null)
  let complete!: (items: AttachmentInfo[]) => void
  store.getState().updateDraft(id, { text: 'delete me', attachments: [item('existing')] })
  const work = module.stageDraftAttachments(id, [() => new Promise(resolve => { complete = resolve })])
  store.getState().deleteSession(id)
  complete([item('orphan')])
  await work
  expect(api.releaseAttachments).toHaveBeenCalledWith(['orphan'])
  expect(store.getState().drafts[id]).toBeUndefined()
})

it('restores new attachment IDs and keeps missing-file errors visible', async () => {
  const id = store.getState().openSession('chat', null)
  store.getState().updateDraft(id, { text: 'review both', attachments: [item('old'), item('missing')] })
  api.addAttachments.mockImplementation(async ([path]: string[]) => {
    if (path?.includes('missing')) throw new Error('File no longer exists')
    return [item('new')]
  })
  await module.restoreDraftAttachments()
  expect(store.getState().drafts[id]?.text).toBe('review both')
  expect(store.getState().drafts[id]?.attachments.map(a => a.id)).toEqual(['new'])
  expect(store.getState().drafts[id]?.attachmentErrors?.[0]).toContain('missing.txt')
  expect(module.useAttachmentJobs.getState().pending[id]).toBe(0)
  await module.restoreDraftAttachments()
  expect(api.addAttachments).toHaveBeenCalledTimes(2)
})

it('does not resurrect a chip removed while restoration was running', async () => {
  const id = store.getState().openSession('chat', null)
  store.getState().updateDraft(id, { attachments: [item('old')] })
  let complete!: (items: AttachmentInfo[]) => void
  api.addAttachments.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  const work = module.restoreDraftAttachments()
  store.getState().updateDraft(id, { attachments: [] })
  complete([item('new')])
  await work
  expect(store.getState().drafts[id]?.attachments).toEqual([])
  expect(api.releaseAttachments).toHaveBeenCalledWith(['new'])
})

it('keeps dashboard uploads when its composer unmounts', async () => {
  const id = module.DASHBOARD_DRAFT
  store.getState().updateDraft(id, { text: 'dashboard work', mode: 'chat' })
  await module.stageDraftAttachments(id, [async () => [item('dashboard')]])
  expect(store.getState().drafts[id]?.attachments.map(a => a.id)).toEqual(['dashboard'])
  expect(store.getState().drafts[id]?.text).toBe('dashboard work')
})
