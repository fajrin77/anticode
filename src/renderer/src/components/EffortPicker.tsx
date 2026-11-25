import type { JSX } from 'react'
import { ROTATE_PROVIDER } from '@shared/ipc'
import type { ProviderInfo, SessionStatus } from '@shared/ipc'
import { EFFORT_LABELS, modelEffort } from '@shared/effort'
import type { EffortLevel, ModelEffort } from '@shared/effort'

export interface EffortTarget {
  model: string
  spec: ModelEffort
  current: EffortLevel
  /** The provider uses its default because nothing was picked for this model. */
  isDefault: boolean
}

/**
 * The model whose effort the chip sets: the session's model, or under Rotate
 * the one that answered last. Null when that model has no effort knob, so
 * the chip only appears where a level can actually be sent.
 */
export function effortTarget(status: SessionStatus | null, providers: ProviderInfo[]): EffortTarget | null {
  if (status === null) return null
  const choice = status.provider === ROTATE_PROVIDER ? status.lastUsed : { provider: status.provider, model: status.model }
  if (choice === null || choice.model === '') return null
  const spec = modelEffort(providers.find((provider) => provider.id === choice.provider), choice.model)
  if (spec === null) return null
  const picked = status.efforts?.[choice.model]
  const current = picked !== undefined && spec.levels.includes(picked) ? picked : spec.default
  return { model: choice.model, spec, current, isDefault: current === spec.default }
}

/** Levels that spend noticeably more of a plan or a budget than the default. */
function costly(level: EffortLevel): boolean {
  return level === 'max'
}

export function EffortMenu({ target, onPicked }: { target: EffortTarget; onPicked: () => void }): JSX.Element {
  const choose = (level: EffortLevel): void => {
    // The default is stored as no choice, so a later change of the provider's own default follows through.
    void window.anticode.setModelEffort(target.model, level === target.spec.default ? null : level).catch(() => undefined)
    onPicked()
  }
  return (
    <div data-effort-menu role="menu" aria-label={`Effort for ${target.model}`}
      className="menu-glass absolute bottom-full left-3 z-20 mb-2 w-80 rounded-xl border p-1.5">
      <div className="px-2 pt-1 pb-2">
        <div className="truncate font-mono text-[11px] text-faint" title={target.model}>{target.model}</div>
        <p className="mt-1 text-[11.5px] leading-snug text-dim">
          Higher effort gives more thorough answers, but takes longer and uses your limits faster.
        </p>
      </div>
      {target.spec.levels.map((level) => (
        <button
          key={level}
          type="button"
          role="menuitemradio"
          aria-checked={level === target.current}
          onClick={() => choose(level)}
          className={`group flex h-8 w-full items-center gap-2 rounded border border-transparent px-2 text-left text-[12.5px] transition-colors hover:bg-hover hover:text-brand ${
            level === target.current ? 'text-text' : 'text-dim'
          }`}
        >
          <span className="min-w-0 flex-1">{EFFORT_LABELS[level]}</span>
          {level === target.spec.default && (
            <span className="shrink-0 rounded bg-raised px-1.5 text-[10.5px] leading-[18px] text-faint transition-colors group-hover:text-brand">Default</span>
          )}
          {costly(level) && (
            <span className="shrink-0 rounded bg-raised px-1.5 text-[10.5px] leading-[18px] text-del transition-colors group-hover:text-brand">Uses limits much faster</span>
          )}
          <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"
            className={`shrink-0 text-brand ${level === target.current ? '' : 'invisible'}`}>
            <path d="M3 8.5l3.2 3L13 4.5" />
          </svg>
        </button>
      ))}
    </div>
  )
}

/** The chip's short name; the menu keeps the full one. */
const chipLabel = (level: EffortLevel): string => level === 'xhigh' ? 'XHigh' : EFFORT_LABELS[level]

/** The chip's face: bars that fill with the level, and its name. */
export function EffortLabel({ target }: { target: EffortTarget }): JSX.Element {
  const index = target.spec.levels.indexOf(target.current)
  const filled = Math.round(((index + 1) / target.spec.levels.length) * 3)
  // Room for the longest name this model offers, so picking a level never pushes the chips beside it.
  const longest = Math.max(...target.spec.levels.map((level) => chipLabel(level).length))
  return (
    <span data-menu-chip className="flex items-center gap-1.5 whitespace-nowrap" style={{ minWidth: `calc(${longest * 0.5}em + 17px)` }}
      title={`Effort: ${EFFORT_LABELS[target.current]}`}>
      <svg aria-hidden width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
        {[0, 1, 2].map((bar) => (
          <rect key={bar} x={bar * 4} y={8 - bar * 3} width="3" height={4 + bar * 3} rx="0.8" opacity={bar < filled ? 1 : 0.3} />
        ))}
      </svg>
      <span>{chipLabel(target.current)}</span>
    </span>
  )
}
