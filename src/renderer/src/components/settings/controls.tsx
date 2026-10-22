import type { JSX } from 'react'

/**
 * The one switch the app has: Auto-accept, Rotate usage, and every model in
 * Settings → Models. Extra data-* attributes land on the button.
 */
export function Toggle({
  on,
  onChange,
  label,
  title,
  disabled = false,
  mixed = false,
  triState = false,
  ...data
}: {
  on: boolean
  onChange: (value: boolean) => void
  label?: string
  title?: string
  disabled?: boolean
  mixed?: boolean
  triState?: boolean
  [attribute: `data-${string}`]: string
}): JSX.Element {
  return (
    <button
      type="button"
      role={triState ? 'checkbox' : 'switch'}
      aria-checked={mixed ? 'mixed' : on}
      disabled={disabled}
      aria-label={label}
      title={title}
      {...data}
      onClick={() => onChange(!on)}
      className={`group/switch h-5 w-9 shrink-0 rounded-full border p-0.5 transition-colors ${on || mixed ? 'border-brand bg-brand' : 'glass-control'}`}
    >
      {/* On the lime track the knob goes dark: white on lime is all but
          invisible, and dark-on-lime is what every other lime control does.
          Off, the knob is what lights up under the cursor. */}
      <span
        className={`block h-4 w-4 rounded-full shadow transition-[transform,background-color] ${
          mixed ? 'translate-x-1.5 bg-bg' : on ? 'translate-x-3.5 bg-bg' : 'translate-x-0 bg-white group-hover/switch:bg-brand'
        }`}
      />
    </button>
  )
}

export function SettingRow({
  title,
  hint,
  children
}: {
  title: string
  hint: string
  children: JSX.Element | string
}): JSX.Element {
  return (
    <div className="flex items-center gap-6 border-b border-line-soft px-5 py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] text-text" title={hint}>{title}</div>
      </div>
      <div className="shrink-0 text-[13px] text-dim">{children}</div>
    </div>
  )
}

