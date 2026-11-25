import { create } from 'zustand'

/**
 * The file open in the viewer. A produced file is named by its path inside
 * its session's folder; an attachment by the absolute path it was sent from.
 */
export type PreviewTarget =
  | { kind: 'artifact'; sessionId: string; path: string; line?: number }
  | { kind: 'attachment'; path: string; name: string }

interface PreviewState {
  target: PreviewTarget | null
  open: (target: PreviewTarget) => void
  close: () => void
}

export const usePreviewStore = create<PreviewState>()((set) => ({
  target: null,
  open: (target) => set((state) => ({
    target: state.target?.kind === target.kind && state.target.path === target.path &&
      (target.kind !== 'artifact' || (state.target.kind === 'artifact' && state.target.sessionId === target.sessionId && state.target.line === target.line))
      ? null : target
  })),
  close: () => set({ target: null })
}))
