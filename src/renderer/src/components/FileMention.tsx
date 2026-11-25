import { useEffect, useId, useState } from 'react'
import type { JSX, KeyboardEvent, RefObject } from 'react'

export function useFileMention(
  root: string | null | undefined,
  text: string,
  setText: (text: string) => void,
  input: RefObject<HTMLTextAreaElement | null>
): { menu: JSX.Element | null; track: (input: HTMLTextAreaElement) => void; onKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean } {
  const id = useId()
  const [caret, setCaret] = useState(0)
  const [closed, setClosed] = useState(false)
  const [active, setActive] = useState(0)
  const [results, setResults] = useState<{ query: string; root: string; files: string[] } | null>(null)
  const token = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))
  const query = token?.[1]
  const enabled = Boolean(root) && query !== undefined && !closed
  const files = enabled && results !== null && results.query === query && results.root === root ? results.files : []
  const track = (element: HTMLTextAreaElement): void => {
    setCaret(element.selectionStart)
    setClosed(false)
  }

  useEffect(() => {
    setActive(0)
    if (!enabled || !root || query === undefined) return
    let current = true
    const timer = setTimeout(() => {
      void window.anticode.searchWorkspaceFiles(root, query).then(
        files => { if (current) setResults({ root, query, files }) },
        () => { if (current) setResults({ root, query, files: [] }) }
      )
    }, 130)
    return () => { current = false; clearTimeout(timer) }
  }, [enabled, root, query])

  const insert = (file: string): void => {
    if (query === undefined) return
    const name = /\s/.test(file) ? JSON.stringify(file) : file
    const end = caret + name.length - query.length + 1
    setText(text.slice(0, caret - query.length) + name + ' ' + text.slice(caret))
    setClosed(true)
    requestAnimationFrame(() => input.current?.setSelectionRange(end, end))
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!enabled || event.nativeEvent.isComposing) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      setClosed(true)
      return true
    }
    if (!files.length) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive(index => (index + step + files.length) % files.length)
      return true
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      insert(files[active % files.length]!)
      return true
    }
    return false
  }

  const menu = files.length === 0 ? null : <div className="relative" data-file-mention>
    <div id={id} role="listbox" aria-label="Workspace files"
      className="glass-surface absolute bottom-1 left-2 z-30 max-h-52 w-[min(30rem,90%)] overflow-auto rounded-lg border border-line p-1 shadow-lg">
      {files.map((file, index) => <button key={file} type="button" role="option" aria-selected={index === active}
        onMouseDown={event => event.preventDefault()} onClick={() => insert(file)}
        className={`block w-full truncate rounded px-2 py-1 text-left font-mono text-xs transition-colors hover:text-brand ${index === active ? 'bg-hover text-text' : 'text-dim'}`}
        title={file}>{file}</button>)}
    </div>
  </div>
  return { menu, track, onKey }
}
