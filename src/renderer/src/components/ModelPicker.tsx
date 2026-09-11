import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { ROTATE_PROVIDER } from '@shared/ipc'
import type { ModelCatalogue, ProviderId, ProviderInfo, SessionStatus } from '@shared/ipc'

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
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const provider = status?.provider ?? 'anthropic'
  const rotating = provider === ROTATE_PROVIDER
  const pool = status?.rotation ?? []
  // The models ticked in Settings → Models for this provider. When there are
  // any, they are the whole list; the catalogue is only a search away.
  const picked = pool.filter((entry) => entry.provider === provider).map((entry) => entry.model)
  const shortlisted = picked.length > 0 && !showAll

  useEffect(() => {
    let active = true
    setCatalogue(null)
    // Rotation is not a provider with a catalogue; its list is the pool.
    if (rotating) {
      setLoading(false)
      return
    }
    setLoading(true)
    void window.anticode.listModels(provider).then((result) => {
      if (!active) return
      setCatalogue(result)
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [provider, rotating])

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '' && shortlisted) {
      // The session's own model stays in view even when it was not ticked.
      const current = status?.model !== undefined && status.model !== '' && !picked.includes(status.model) ? [status.model] : []
      return [...current, ...picked]
    }
    const models = [...new Set([...picked, ...(catalogue?.models ?? [])])]
    return needle === '' ? models : models.filter((id) => id.toLowerCase().includes(needle))
  }, [catalogue, query, shortlisted, picked.join('\n'), status?.model])

  const typedIsNew = query.trim() !== '' && !matches.includes(query.trim())
  const tabs = [
    ...providers.map((entry) => ({ id: entry.id, label: entry.label, available: entry.credentialAvailable, hint: entry.credentialAvailable ? entry.label : `Needs ${entry.credentialHint}` })),
    // Offered once the pool has something to rotate over.
    ...(pool.length > 0
      ? [{ id: ROTATE_PROVIDER, label: 'Rotate', available: true, hint: 'Spread this session’s prompts over the Rotate usage pool' }]
      : [])
  ]

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
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {pool.map((entry) => (
              <div
                key={`${entry.provider}\n${entry.model}`}
                className={`flex items-center gap-2 rounded px-2 py-1 font-mono text-[11.5px] ${
                  entry.ready ? 'text-dim' : 'text-faint'
                }`}
              >
                <span className="min-w-0 flex-1 truncate" title={`${entry.label} · ${entry.model}`}>
                  {entry.model}
                </span>
                {status?.lastUsed?.provider === entry.provider && status.lastUsed.model === entry.model && (
                  <span className="shrink-0 text-text">last</span>
                )}
                <span className="shrink-0 text-faint">
                  {entry.ready ? compactTokens(entry.inputTokens + entry.outputTokens) : 'no key'}
                </span>
              </div>
            ))}
          </div>
          <div className="border-t border-line-soft px-3 py-1.5 text-[11px] leading-relaxed text-faint">
            This session stays on a model for 2 prompts, then moves to the one that has used the
            fewest tokens. Pick the models in Settings → Models.
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
            {loading && <div className="px-2 py-3 text-[12px] text-faint">Loading models…</div>}

            {/* With models picked there is a list to show; the failure can wait. */}
            {!loading && catalogue?.error !== null && catalogue !== null && !shortlisted && (
              <div className="max-h-24 overflow-y-auto px-2 py-2 text-[11.5px] leading-relaxed text-faint">
                Could not load the model list: {catalogue.error}. Type a model id and press Enter,
                or add its model ids in Settings → Providers → Edit.
              </div>
            )}

            {!loading && catalogue?.error === null && matches.length === 0 && (
              <div className="px-2 py-3 text-[12px] leading-relaxed text-faint">
                {catalogue.models.length === 0
                  ? 'This provider offers no model list. Type an id and press Enter, or add its model ids in Settings → Providers → Edit.'
                  : 'No matches. Press Enter to use the id you typed.'}
              </div>
            )}

            {typedIsNew && matches.length > 0 && (
              <button
                type="button"
                onClick={() => onSelect(provider, query.trim())}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[11.5px] text-dim transition-colors hover:bg-hover hover:text-brand"
              >
                Use this id: {query.trim()}
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

          {catalogue !== null && catalogue.models.length > 0 && (
            <div className="flex items-center justify-between gap-3 border-t border-line-soft px-3 py-1.5 text-[11px] text-faint">
              {picked.length > 0 ? (
                <button
                  type="button"
                  data-picker-scope
                  onClick={() => setShowAll((value) => !value)}
                  title={shortlisted ? 'Show the whole catalogue' : 'Show only the models picked in Settings → Models'}
                  className="min-w-0 truncate transition-colors hover:text-brand"
                >
                  {shortlisted ? `${picked.length} picked · show all ${catalogue.models.length}` : `All ${catalogue.models.length} · show picked`}
                </button>
              ) : (
                <span className="min-w-0 truncate">
                  {providers.find((entry) => entry.id === provider)?.label ?? provider} ·{' '}
                  {catalogue.models.length} models · pick favourites in Settings → Models
                </span>
              )}
              <button
                type="button"
                onClick={() => {
                  setLoading(true)
                  void window.anticode.listModels(provider, true).then((result) => {
                    setCatalogue(result)
                    setLoading(false)
                  })
                }}
                className="shrink-0 transition-colors hover:text-brand"
              >
                Reload
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
