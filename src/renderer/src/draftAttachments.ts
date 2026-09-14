import { create } from 'zustand'
import type { AttachmentInfo } from '@shared/ipc'
import { useSessionStore } from './store/session'

export const DASHBOARD_DRAFT = '__dashboard__'

export const useAttachmentJobs = create<{ pending: Record<string, number> }>(() => ({ pending: {} }))
const changePending = (id: string, delta: number) => useAttachmentJobs.setState(state => ({
  pending: { ...state.pending, [id]: Math.max(0, (state.pending[id] ?? 0) + delta) }
}))
export function attachmentError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Jobs belong to a draft, not to the component/tab that started them. */
export async function stageDraftAttachments(id: string, jobs: Array<() => Promise<AttachmentInfo[]>>): Promise<void> {
  changePending(id, jobs.length)
  await Promise.all(jobs.map(async job => {
    try {
      const added = await job()
      const store = useSessionStore.getState()
      if (id !== DASHBOARD_DRAFT && !store.sessions.some(s => s.id === id)) {
        await window.anticode.releaseAttachments(added.map(item => item.id))
        return
      }
      store.updateDraft(id, { attachments: [...(store.drafts[id]?.attachments ?? []), ...added] })
    } catch (error) {
      const store = useSessionStore.getState()
      if (id === DASHBOARD_DRAFT || store.sessions.some(s => s.id === id)) store.updateDraft(id, {
        attachmentErrors: [...(store.drafts[id]?.attachmentErrors ?? []), attachmentError(error)]
      })
    } finally { changePending(id, -1) }
  }))
}

let restoration: Promise<void> | undefined
/** IDs are process-local. Re-register persisted file paths before a draft can send. */
export function restoreDraftAttachments(): Promise<void> {
  if (restoration) return restoration
  restoration = Promise.all(Object.entries(useSessionStore.getState().drafts).map(async ([id, draft]) => {
    const items = draft.attachments ?? []
    if (!items.length) return
    changePending(id, items.length)
    await Promise.all(items.map(async item => {
      try {
        const added = await window.anticode.addAttachments([item.path])
        const store = useSessionStore.getState()
        const current = store.drafts[id]?.attachments ?? []
        // Removing a chip during restoration must not resurrect it.
        if (!current.some(a => a.id === item.id)) {
          await window.anticode.releaseAttachments(added.map(a => a.id))
          return
        }
        store.updateDraft(id, { attachments: current.flatMap(a => a.id === item.id ? added : [a]) })
      } catch (error) {
        const store = useSessionStore.getState()
        const current = store.drafts[id]
        if (!current?.attachments.some(a => a.id === item.id)) return
        store.updateDraft(id, {
          attachments: current.attachments.filter(a => a.id !== item.id),
          attachmentErrors: [...(current.attachmentErrors ?? []), `${item.name}: ${attachmentError(error)}. Attach this file again or dismiss this warning to send without it.`]
        })
      } finally { changePending(id, -1) }
    }))
  })).then(() => undefined)
  return restoration
}

export function fileAttachmentJob(file: File): () => Promise<AttachmentInfo[]> {
  return async () => {
    const filePath = window.anticode.pathForFile(file)
    if (filePath) return window.anticode.addAttachments([filePath])
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
    return window.anticode.addAttachmentData(file.name || `attachment-${Date.now()}`, btoa(binary))
  }
}
