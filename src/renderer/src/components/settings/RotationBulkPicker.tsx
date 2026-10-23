import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { ModelCatalogue, ProviderInfo, RotationEntry } from '@shared/ipc'
import { modelSearchKey, rotationChoices } from '@shared/rotationChoices'

export function RotationBulkPicker({ providers, selected, onAdd, onIndividual, onCancel }: {
  providers: ProviderInfo[]
  selected: RotationEntry[]
  onAdd: (entries: RotationEntry[]) => Promise<boolean>
  onIndividual: () => void
  onCancel: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [catalogues, setCatalogues] = useState<ModelCatalogue[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [failures, setFailures] = useState<string[]>([])
  // Account catalogue calls stay separate: an id offered by one account is
  // never copied to another. Retired routes are filtered by the main process.
  const ids = providers.map(provider => provider.id).join('\n')
  useEffect(() => {
    let active = true
    setLoading(true)
    setCatalogues([])
    setFailures([])
    const accountIds = ids === '' ? [] : ids.split('\n')
    void Promise.all(accountIds.map(async provider => {
      try { return await window.anticode.listModels(provider) }
      catch { return { provider, models: [], error: 'Could not load catalogue' } }
    })).then(results => {
      if (!active) return
      setCatalogues(results)
      setFailures(results.filter(result => result.error !== null).map(result => result.provider))
      setLoading(false)
    })
    return () => { active = false }
  }, [ids])
  const choices = useMemo(() => rotationChoices(providers, catalogues, selected), [providers, catalogues, selected])
  const key = modelSearchKey(query)
  const services = choices.services.filter(choice => modelSearchKey(choice.label).includes(key))
  const models = choices.models.filter(choice => choice.id.includes(key))
  const buttonClass = 'flex w-full items-start justify-between gap-3 rounded-md px-3 py-2 text-left text-[12.5px] text-dim hover:bg-hover hover:text-brand disabled:opacity-50'
  const rows = (kind: string, items: typeof models): JSX.Element => <div>
    <p className="px-3 py-1 text-[11px] text-faint">{kind}</p>
    {items.map(choice => <button key={choice.id} type="button" data-rotation-bulk={kind === 'Services' ? 'service' : 'model'} data-choice={choice.id} disabled={loading || saving} className={buttonClass} onClick={() => {
      setSaving(true)
      void onAdd(choice.entries).finally(() => setSaving(false))
    }}>
      <span className="min-w-0 [overflow-wrap:anywhere]">{choice.label}</span>
      <span className="shrink-0 text-[11px] text-faint">{choice.accounts} accounts · {choice.entries.length} routes</span>
    </button>)}
  </div>
  return <div data-rotation-bulk-picker className="min-w-0 border-t border-line-soft px-5 py-3">
    <input autoFocus aria-label="Search services or models" placeholder="Search services or models, e.g. Cline or Deepseek 4.1 Flash" value={query} onChange={event => setQuery(event.target.value)} className="glass-field w-full rounded-lg border border-line px-3 py-2 text-[12.5px] text-text outline-none" />
    <p className="my-2 text-[11.5px] text-faint">One click adds all listed accounts and routes. Includes free/subscription catalogues and models already selected; catalogue access does not guarantee inference.</p>
    {loading ? <p role="status" className="text-[12px] text-dim">Loading account catalogues…</p> : <div className="max-h-64 overflow-y-auto">{services.length > 0 && rows('Services', services)}{models.length > 0 && rows('Models across accounts', models)}{services.length === 0 && models.length === 0 && <p className="py-2 text-[12px] text-dim">No matching routes. Choose an individual account to configure a model.</p>}</div>}
    {failures.length > 0 && <p role="alert" className="mt-2 text-[12px] text-del [overflow-wrap:anywhere]">Some catalogues could not be loaded: {failures.map(id => providers.find(provider => provider.id === id)?.label ?? id).join(', ')}. Cancel and reopen to retry.</p>}
    <div className="mt-2 flex gap-4 text-[12px]"><button type="button" disabled={saving} onClick={onIndividual} className="text-brand">Choose one account / model</button><button type="button" disabled={saving} onClick={onCancel} className="text-dim">Cancel</button></div>
  </div>
}
