import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import { activeRotationEntries, activeRotationGroup, ROTATE_PROVIDER } from '@shared/ipc'
import type { ProviderId, ProviderInfo, SessionStatus } from '@shared/ipc'

interface ModelPickerProps {
  status: SessionStatus | null
  providers: ProviderInfo[]
  onSelect: (provider: ProviderId, model: string) => void
  onClose: () => void
}

/** 12,345 → "12.3k": the pool list only needs to show which entry is ahead. */
export function compactTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

export function ModelPicker({
  status,
  providers,
  onSelect,
  onClose
}: ModelPickerProps): JSX.Element {
  const [query, setQuery] = useState('')
  const provider = status?.provider ?? 'anthropic'
  const rotating = provider === ROTATE_PROVIDER
  const pool = status?.rotation ?? []
  // The models switched on in Settings → Models for this provider are the
  // whole list: a catalogue of hundreds is chosen from there, not from here.
  // Until something is switched on the list is empty — and the session's model
  // is always one of these (or none), so nothing else ever shows.
  const picked = pool.filter((entry) => entry.provider === provider).map((entry) => entry.model)
  const providerLabel = providers.find((entry) => entry.id === provider)?.label ?? provider
  // Rotating, the list is what sessions rotate over: the group in use, or all.
  const rotatingOver = activeRotationEntries(status)
  const group = activeRotationGroup(status)
  const groups = status?.rotationGroups ?? []
  const [groupError, setGroupError] = useState<string | null>(null)

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle === '' ? picked : picked.filter((id) => id.toLowerCase().includes(needle))
  }, [query, picked.join('\n')])

  const typedIsNew = query.trim() !== '' && !matches.includes(query.trim())
  const tabs = status?.rotationEnabled === true
    ? [{ id: ROTATE_PROVIDER, label: 'Rotate', available: true, hint: 'Rotate usage controls every session while it is on' }]
    : providers.map((entry) => ({ id: entry.id, label: entry.label, available: entry.credentialAvailable, hint: entry.credentialAvailable ? entry.label : `Needs ${entry.credentialHint}` }))

  return (
    <div className="menu-glass absolute bottom-full left-3 z-20 mb-2 flex max-h-72 w-80 flex-col overflow-hidden rounded-xl border">
      {tabs.length > 1 && (
        <div className="flex flex-wrap gap-0.5 border-b border-line-soft p-1.5">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => onSelect(entry.id, '')}
              title={entry.hint}
              className={`rounded px-2 py-1 text-[12px] transition-colors ${
                entry.id === provider
                  ? 'bg-hover text-text'
                  : entry.available
                    ? 'text-dim hover:bg-hover hover:text-brand'
                    : 'text-faint'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}

      {rotating ? (
        <>
          {/* Which group every session rotates over, switched from here as
              in Settings: the main process owns it, so every composer and
              the phone follow at once. */}
          {groups.length > 0 && (
            <div data-picker-groups className="flex flex-wrap gap-0.5 border-b border-line-soft p-1.5">
              {[{ id: null as string | null, name: 'All models' }, ...groups].map((choice) => (
                <button
                  key={choice.id ?? ''}
                  type="button"
                  data-picker-group={choice.name}
                  title={choice.id === (group?.id ?? null) ? `${choice.name} — in use` : `Rotate over ${choice.name}`}
                  onClick={() => {
                    if (choice.id === (group?.id ?? null)) return
                    setGroupError(null)
                    void window.anticode
                      .selectRotationGroup(choice.id)
                      .catch((failure: Error) =>
                        setGroupError(failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
                      )
                  }}
                  className={`max-w-40 truncate rounded border px-2 py-1 text-[12px] transition-colors ${
                    choice.id === (group?.id ?? null)
                      ? 'border-line bg-hover text-text'
                      : 'border-transparent text-dim hover:bg-hover hover:text-brand'
                  }`}
                >
                  {choice.name}
                </button>
              ))}
            </div>
          )}
          {groupError !== null && <div className="border-b border-line-soft px-3 py-1.5 text-[11.5px] text-del">{groupError}</div>}
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {rotatingOver.map((entry) => (
              <div
                key={`${entry.provider}\n${entry.model}`}
                className={`flex items-center gap-2 rounded px-2 py-1 font-mono text-[11.5px] ${
                  entry.ready && entry.outOfUsage === null ? 'text-dim' : 'text-faint'
                }`}
              >
                <span className="min-w-0 flex-1 truncate" title={`${entry.label} · ${entry.model}`}>
                  {entry.model}
                </span>
                {status?.lastUsed?.provider === entry.provider && status.lastUsed.model === entry.model && (
                  <span className="shrink-0 text-text">last</span>
                )}
                <span
                  className={`shrink-0 ${entry.outOfUsage !== null ? 'text-del' : 'text-faint'}`}
                  title={entry.outOfUsage?.reason}
                >
                  {!entry.ready
                    ? 'no key'
                    : entry.outOfUsage !== null
                      ? 'out of usage'
                      : compactTokens(entry.inputTokens + entry.outputTokens)}
                </span>
              </div>
            ))}
          </div>
          <div className="border-t border-line-soft px-3 py-1.5 text-[11px] leading-relaxed text-faint">
            This session stays on a model for 2 prompts, then moves to the one that has used the
            fewest tokens. Models and groups are made in Settings → Providers.
          </div>
        </>
      ) : (
        <>
          <input
            value={query}
            autoFocus
            placeholder="Search models, or type an id"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose()
              if (event.key === 'Enter' && query.trim() !== '') onSelect(provider, query.trim())
            }}
            className="border-b border-line-soft bg-transparent px-3 py-1.5 text-[12px] text-text outline-none placeholder:text-faint"
          />

          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {matches.length === 0 && (
              <div data-picker-empty className="px-2 py-3 text-[12px] leading-relaxed text-faint">
                {query.trim() === ''
                  ? `No ${providerLabel} models chosen yet. Choose the ones you want in Settings → Models.`
                  : 'No matches. Press Enter to add the id you typed and use it.'}
              </div>
            )}

            {typedIsNew && matches.length > 0 && (
              <button
                type="button"
                onClick={() => onSelect(provider, query.trim())}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[11.5px] text-dim transition-colors hover:bg-hover hover:text-brand"
              >
                Add and use: {query.trim()}
              </button>
            )}

            {matches.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => onSelect(provider, id)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[11.5px] transition-colors hover:bg-hover hover:text-brand ${
                  id === status?.model ? 'text-text' : 'text-dim'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{id}</span>
                {id === status?.model && <span className="shrink-0">✓</span>}
              </button>
            ))}
          </div>

          {picked.length > 0 && (
            <div className="truncate border-t border-line-soft px-3 py-1.5 text-[11px] text-faint">
              {providerLabel} · {picked.length} chosen · more in Settings → Models
            </div>
          )}
        </>
      )}
    </div>
  )
}
