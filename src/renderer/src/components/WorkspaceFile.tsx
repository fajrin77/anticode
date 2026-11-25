import { createContext, useContext, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { usePreviewStore } from '../store/preview'

export const WorkspaceFileContext = createContext<string | null>(null)

/** Paths already checked, so a long transcript asks once per file. */
const present = new Map<string, Promise<boolean>>()

export function looksLikeFile(value: string): boolean {
  return !/^[a-z]+:\/\//i.test(value) &&
    /^(?:[\w.@+~ -]+[\\/])*[\w.@+ -]+\.[a-z\d]+(?:(?::|#L)\d+(?::\d+)?)?$/i.test(value.replace(/^(?:[a-z]:)?[\\/]/i, ''))
}

export function WorkspaceFile({ location, label = location, line, known = false }: { location: string; label?: string; line?: number | undefined; known?: boolean }): JSX.Element {
  const id = useContext(WorkspaceFileContext)
  const linkable = id !== null && (known || looksLikeFile(location)) && !location.includes('\n')
  const match = /^(.*?)(?:(?::|#L)([1-9]\d*)(?::\d+)?)?$/.exec(location)
  const path = match?.[1] ?? location
  const [exists, setExists] = useState(true)
  useEffect(() => {
    if (!linkable || id === null) return
    const key = `${id}\n${path}`
    let check = present.get(key)
    if (check === undefined) {
      check = window.anticode.fileExists(id, path).catch(() => true)
      present.set(key, check)
      // A file may come back later; forget the answer once it has been used.
      void check.then(() => setTimeout(() => present.delete(key), 5000))
    }
    let current = true
    void check.then(found => { if (current) setExists(found) })
    return () => { current = false }
  }, [linkable, id, path])
  // A file that is gone stays plain text: there is nothing to open.
  if (!linkable || id === null || !exists) return <>{label}</>
  return <button type="button" className="text-left underline decoration-brand/40 underline-offset-2 transition-colors hover:text-brand"
    title={'Preview ' + location} onClick={() => {
      usePreviewStore.getState().open({ kind: 'artifact', sessionId: id, path, line: Math.max(1, Number(match?.[2] ?? line ?? 1)) })
    }}>{label}</button>
}
