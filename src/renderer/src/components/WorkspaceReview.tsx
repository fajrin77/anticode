import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { WorkspaceChanges } from '@shared/ipc'
import { useSessionStore } from '../store/session'
import { DiffView } from './DiffView'
import { WorkspaceFileContext } from './WorkspaceFile'

export function WorkspaceReview({ sessionId }: { sessionId: string }): JSX.Element | null {
  const [status, setStatus] = useState<WorkspaceChanges | null>(null)
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<string | null>(null)
  const [diff, setDiff] = useState<Awaited<ReturnType<typeof window.anticode.workspacePatch>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reverting, setReverting] = useState(false)
  const busy = useSessionStore(state => [...Object.values(state.activeRuns), ...Object.values(state.mirrorRuns)].some(run => run.sessionId === sessionId))
  const refresh = useCallback(() => {
    void window.anticode.workspaceChanges(sessionId).then(setStatus).catch(() => setStatus(null))
  }, [sessionId])
  useEffect(refresh, [refresh, busy])
  // Git is asked again only while the window is in view; a hidden window has nobody to show it to.
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) refresh() }, 10_000)
    const onVisible = (): void => { if (!document.hidden) refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [refresh])

  useEffect(() => {
    setDiff(null)
    setError(null)
    if (!open || file === null) return
    let current = true
    void window.anticode.workspacePatch(sessionId, file).then(
      result => { if (current) setDiff(result) },
      error => { if (current) setError(String(error)) }
    )
    return () => { current = false }
  }, [open, file, busy, sessionId])

  async function revert(hunk: number | null): Promise<void> {
    if (!diff || !file || reverting || busy) return
    setReverting(true)
    try {
      if (await window.anticode.revertWorkspacePatch(sessionId, file, diff.revision, hunk)) {
        refresh()
        setDiff(await window.anticode.workspacePatch(sessionId, file))
      }
    } catch (failure) {
      setError(String(failure))
    } finally {
      setReverting(false)
    }
  }

  if (status === null) return null
  return <div className="relative region-no-drag">
    <button type="button" aria-expanded={open} aria-label="Review workspace changes"
      title={status.branch} className={`max-w-40 truncate rounded border px-2 py-1 font-mono text-xs transition-colors hover:text-brand ${open ? 'glass-control text-text' : 'glass-ghost text-dim'}`}
      onClick={() => { setOpen(value => !value); refresh() }}>
      {status.branch.split('...')[0]}{status.dirty ? ' ●' : ''}
    </button>
    {open && <div className="menu-glass absolute top-9 right-0 z-50 flex max-h-[70vh] w-[min(46rem,85vw)] flex-col gap-2 overflow-auto rounded-xl border p-3 shadow-xl"
      onKeyDown={event => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); setOpen(false) }
      }}>
      <div className="flex items-center justify-between text-xs text-dim">
        <span>{status.branch}</span>
        <button type="button" aria-label="Close workspace review"
          className="flex h-5 w-5 items-center justify-center rounded text-dim transition-colors hover:bg-raised hover:text-brand"
          onClick={() => setOpen(false)}>×</button>
      </div>
      {!status.dirty && <p className="text-sm text-dim">Working tree is clean.</p>}
      {status.files.map(entry => <button type="button" key={entry.path} onClick={() => setFile(entry.path)} aria-pressed={file === entry.path}
        className={`group truncate rounded border px-2 py-1 text-left font-mono text-xs transition-colors hover:bg-hover hover:text-brand ${file === entry.path ? 'border-line bg-raised text-text' : 'border-transparent text-dim'}`}>
        <span className="mr-2 text-faint transition-colors group-hover:text-brand">{entry.status}</span>{entry.path}
      </button>)}
      {error && <p role="alert" className="text-xs text-del">{error}</p>}
      {file && diff?.patch && <WorkspaceFileContext.Provider value={sessionId}>
        <div className="flex justify-end">
          <button type="button" disabled={reverting || busy} className="rounded px-2 py-1 text-xs text-dim transition-colors hover:bg-raised hover:text-del disabled:opacity-50"
            onClick={() => void revert(null)}>Revert file</button>
        </div>
        <DiffView path={file} patch={diff.patch} onRevertHunk={!busy && !reverting && diff.hunkRevert ? index => void revert(index) : undefined} />
      </WorkspaceFileContext.Provider>}
      {file && diff?.patch === '' && <p className="text-xs text-dim">No unstaged tracked diff for this file.</p>}
    </div>}
  </div>
}
