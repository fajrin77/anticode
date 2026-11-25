import { createContext, useContext } from 'react'
import type { JSX } from 'react'
import { usePreviewStore } from '../store/preview'

export const WorkspaceFileContext = createContext<string | null>(null)

export function looksLikeFile(value: string): boolean {
  return !/^[a-z]+:\/\//i.test(value) &&
    /^(?:[\w.@+~ -]+[\\/])*[\w.@+ -]+\.[a-z\d]+(?:(?::|#L)\d+(?::\d+)?)?$/i.test(value.replace(/^(?:[a-z]:)?[\\/]/i, ''))
}

export function WorkspaceFile({ location, label = location, line, known = false }: { location: string; label?: string; line?: number | undefined; known?: boolean }): JSX.Element {
  const id = useContext(WorkspaceFileContext)
  if (id === null || (!known && !looksLikeFile(location)) || location.includes('\n')) return <>{label}</>
  const match = /^(.*?)(?:(?::|#L)([1-9]\d*)(?::\d+)?)?$/.exec(location)
  return <button type="button" className="text-left underline decoration-brand/40 underline-offset-2 transition-colors hover:text-brand"
    title={'Preview ' + location} onClick={() => {
      usePreviewStore.getState().open({ kind: 'artifact', sessionId: id, path: match?.[1] ?? location, line: Math.max(1, Number(match?.[2] ?? line ?? 1)) })
    }}>{label}</button>
}
