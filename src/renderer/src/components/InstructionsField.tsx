import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { INSTRUCTIONS_MAX_CHARS } from '@shared/ipc'

/**
 * A box of instructions the model reads with its system prompt. Saved on
 * demand, not on every key: a half-typed rule should not reach a run.
 */
export function InstructionsField({
  value,
  placeholder,
  rows = 5,
  onSave
}: {
  value: string
  placeholder: string
  rows?: number
  onSave: (text: string) => Promise<unknown>
}): JSX.Element {
  const [text, setText] = useState(value)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | string>('idle')
  useEffect(() => setText(value), [value])
  const changed = text !== value
  const tooLong = text.length > INSTRUCTIONS_MAX_CHARS

  async function save(): Promise<void> {
    setState('saving')
    try {
      await onSave(text)
      setState('saved')
      window.setTimeout(() => setState('idle'), 1500)
    } catch (failure) {
      setState((failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const note =
    state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state !== 'idle' ? state : `${text.length.toLocaleString('en-US')} / ${INSTRUCTIONS_MAX_CHARS.toLocaleString('en-US')}`

  return (
    <div>
      <textarea
        value={text}
        rows={rows}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && changed && !tooLong) {
            event.preventDefault()
            void save()
          }
        }}
        placeholder={placeholder}
        className="glass-field w-full resize-y rounded-lg border px-3 py-2 text-[12.5px] leading-relaxed text-text outline-none placeholder:text-faint"
      />
      <div className="mt-1.5 flex items-center gap-3">
        <span className={`flex-1 text-[11px] tabular-nums ${tooLong || (state !== 'idle' && state !== 'saving' && state !== 'saved') ? 'text-del' : 'text-faint'}`}>
          {note}
        </span>
        <button
          type="button"
          disabled={!changed}
          onClick={() => setText(value)}
          className="rounded-md px-2 py-1 text-[12px] text-dim transition-colors enabled:hover:text-brand disabled:invisible"
        >
          Discard
        </button>
        <button
          type="button"
          disabled={!changed || tooLong}
          onClick={() => void save()}
          className="glass-control rounded-md border px-3 py-1 text-[12px] text-text transition-colors enabled:hover:text-brand disabled:text-faint"
        >
          Save
        </button>
      </div>
    </div>
  )
}
