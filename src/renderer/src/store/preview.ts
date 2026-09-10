import { create } from 'zustand'

/**
 * The file open in the viewer. A produced file is named by its path inside
 * its session's folder; an attachment by the absolute path it was sent from.
 */
export type PreviewTarget =
  | { kind: 'artifact'; sessionId: string; path: string }
  | { kind: 'attachment'; path: string; name: string }

interface PreviewState {
  target: PreviewTarget | null
  open: (target: PreviewTarget) => void
  close: () => void
}

export const usePreviewStore = create<PreviewState>()((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null })
}))
