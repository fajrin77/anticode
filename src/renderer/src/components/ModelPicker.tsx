import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { ModelCatalogue, ProviderId, ProviderInfo, SessionStatus } from '@shared/ipc'

interface ModelPickerProps {
  status: SessionStatus | null
  providers: ProviderInfo[]
  onSelect: (provider: ProviderId, model: string) => void
  onClose: () => void
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
  const provider = status?.provider ?? 'anthropic'

  useEffect(() => {
    let active = true
    setCatalogue(null)
    setLoading(true)
    void window.anticode.listModels(provider).then((result) => {
      if (!active) return
      setCatalogue(result)
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [provider])

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const models = catalogue?.models ?? []
    return needle === '' ? models : models.filter((id) => id.toLowerCase().includes(needle))
  }, [catalogue, query])

  const typedIsNew = query.trim() !== '' && !matches.includes(query.trim())

  return (
    <div className="menu-glass absolute bottom-full left-3 z-20 mb-2 flex max-h-72 w-80 flex-col overflow-hidden rounded-xl border">
      {providers.length > 1 && (
        <div className="flex flex-wrap gap-0.5 border-b border-line-soft p-1.5">
          {providers.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => onSelect(entry.id, '')}
              title={entry.credentialAvailable ? entry.label : `Needs ${entry.credentialHint}`}
              className={`rounded px-2 py-1 text-[12px] transition-colors ${
                entry.id === provider
                  ? 'bg-hover text-text'
                  : entry.credentialAvailable
                    ? 'text-dim hover:bg-hover hover:text-brand'
                    : 'text-faint'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}

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

        {!loading && catalogue?.error !== null && catalogue !== null && (
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
            {id === status?.model && <span className="shrink-0 text-text">✓</span>}
          </button>
        ))}
      </div>

      {catalogue !== null && catalogue.models.length > 0 && (
        <div className="flex items-center justify-between border-t border-line-soft px-3 py-1.5 text-[11px] text-faint">
          <span>
            {providers.find((entry) => entry.id === provider)?.label ?? provider} ·{' '}
            {catalogue.models.length} models
          </span>
          <button
            type="button"
            onClick={() => {
              setLoading(true)
              void window.anticode.listModels(provider, true).then((result) => {
                setCatalogue(result)
                setLoading(false)
              })
            }}
            className="transition-colors hover:text-brand"
          >
            Reload
          </button>
        </div>
      )}
    </div>
  )
}
