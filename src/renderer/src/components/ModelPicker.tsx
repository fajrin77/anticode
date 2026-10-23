import { providerModelIssue } from '@shared/providerModel'
import { groupAuthProviders } from '@shared/providerGroups'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  const menuRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const menu = menuRef.current
    const anchor = menu?.parentElement
    if (!menu || !anchor) return
    menu.showPopover()
    const place = (): void => {
      const bounds = anchor.getBoundingClientRect()
      const safeTop = (document.querySelector('header')?.getBoundingClientRect().bottom ?? 0) + 8
      const above = Math.max(0, bounds.top - safeTop - 8)
      const below = Math.max(0, window.innerHeight - bounds.bottom - 16)
      const upwards = above >= Math.min(320, below)
      menu.style.inset = 'auto'
      menu.style.width = `${Math.min(360, window.innerWidth - 24)}px`
      menu.style.maxHeight = `${Math.max(80, Math.min(360, upwards ? above : below))}px`
      menu.style.left = `${Math.max(12, Math.min(bounds.left + 12, window.innerWidth - menu.offsetWidth - 12))}px`
      menu.style.top = `${upwards ? Math.max(safeTop, bounds.top - menu.offsetHeight - 8) : Math.max(safeTop, bounds.bottom + 8)}px`
    }
    place()
    menu.querySelector('input')?.focus({ preventScroll: true })
    const observer = new ResizeObserver(place)
    observer.observe(menu); observer.observe(anchor)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
      if (menu.matches(':popover-open')) menu.hidePopover()
    }
  }, [])
  const [query, setQuery] = useState('')
  const provider = status?.provider ?? 'anthropic'
  // The tab being looked at. Looking is not choosing: the session moves to
  // another provider only when one of its models is picked, so browsing a tab
  // with nothing chosen yet never leaves the session without a model.
  const [viewedId, setViewing] = useState<ProviderId>(provider)
  const visibleProviders = groupAuthProviders(providers.filter((entry) => entry.composerVisible === true))
  const viewing = viewedId === ROTATE_PROVIDER && status?.rotationEnabled === true
    ? ROTATE_PROVIDER
    : visibleProviders.find((entry) => (entry.accountIds ?? [entry.id]).includes(viewedId))?.id ?? visibleProviders[0]?.id ?? ''
  const rotating = viewing === ROTATE_PROVIDER
  const pool = status?.rotation ?? []
  // The models switched on in Settings → Models for this provider are the
  // whole list: a catalogue of hundreds is chosen from there, not from here.
  // Until something is switched on the list is empty. An existing session
  // can keep its current model without reintroducing it into this list.
  const viewedProvider = visibleProviders.find((entry) => entry.id === viewing)
  const accountProvider = viewedProvider?.kind === 'auth'
  const [accountCatalogue, setAccountCatalogue] = useState<{ provider: string; models: string[] } | null>(null)
  useEffect(() => {
    if (!accountProvider) return
    let active = true
    void window.anticode.listModels(viewing, true).then((result) => {
      if (active) setAccountCatalogue({ provider: viewing, models: result.models })
    }).catch(() => {})
    return () => { active = false }
  }, [viewing, accountProvider])
  const configured = [...new Set(pool.filter((entry) => (viewedProvider?.accountIds ?? [viewing]).includes(entry.provider)).map((entry) => entry.model))]
  const freeClineAccount = accountProvider && /^auth:cline(?:-|$)/.test(viewing)
  const accountModels = [...new Set([...(accountCatalogue?.provider === viewing ? accountCatalogue.models : viewedProvider?.models ?? []),
    ...providers.filter((entry) => entry.id !== viewing && viewedProvider?.accountIds?.includes(entry.id)).flatMap((entry) => entry.models ?? [])])]
  const offered = accountProvider
    ? configured.filter((model) => !freeClineAccount || accountModels.includes(model))
    : configured
  const picked = offered
  const providerLabel = visibleProviders.find((entry) => entry.id === viewing)?.label ?? viewing
  const current = (id: string): boolean => (viewedProvider?.accountIds ?? [viewing]).includes(provider) && id === status?.model
  const manualRoute = (model: string): { provider: string; reason: string | null } => {
    const ids = viewedProvider?.accountIds ?? [viewing]
    const available = ids.find(id => {
      const account = providers.find(provider => provider.id === id)
      return account?.credentialAvailable && account.composerVisible !== false && providerModelIssue(account, model) === null && !pool.find(entry => entry.provider === id && entry.model === model)?.unavailableReason
    })
    return { provider: available ?? viewing, reason: available !== undefined ? null : pool.find(entry => ids.includes(entry.provider) && entry.model === model)?.unavailableReason ?? 'No enabled account offers this model. Refresh its catalogue in Settings.' }
  }
  // Rotating, the list is what sessions rotate over: the group in use, or all.
  const rotatingOver = activeRotationEntries(status)
  const group = activeRotationGroup(status)
  const groups = status?.rotationGroups ?? []
  const [groupError, setGroupError] = useState<string | null>(null)

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle === '' ? picked : picked.filter((id) => id.toLowerCase().includes(needle))
  }, [query, picked.join('\n')])

  const typedIsNew = viewing !== '' && query.trim() !== '' && picked.length === 0 && !matches.includes(query.trim())
  const tabs = [
    ...visibleProviders.map((entry) => ({ id: entry.id, label: entry.label, available: entry.credentialAvailable, hint: entry.credentialAvailable ? entry.label : `Needs ${entry.credentialHint}` })),
    ...(status?.rotationEnabled === true
      ? [{ id: ROTATE_PROVIDER, label: 'Rotate usage', available: true, hint: 'Use the rotation pool for this session' }]
      : [])
  ]

  return (
    <div ref={menuRef} popover="manual" data-model-picker role="dialog" aria-label="Choose model" className="menu-glass fixed m-0 flex w-80 flex-col overflow-hidden rounded-xl border p-0">
      {tabs.length > 1 && (
        <div className="grid max-h-36 shrink-0 grid-cols-2 gap-0.5 overflow-y-auto border-b border-line-soft p-1.5">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              data-picker-provider={entry.id}
              type="button"
              onClick={() => {
                if (entry.available) {
                  setViewing(entry.id)
                  setQuery('')
                  // Rotate is a complete choice, unlike a provider tab that
                  // still needs a model. Activate it as soon as it is clicked.
                  if (entry.id === ROTATE_PROVIDER && provider !== ROTATE_PROVIDER) {
                    onSelect(ROTATE_PROVIDER, '')
                  }
                }
              }}
              title={entry.hint}
              className={`min-w-0 truncate rounded px-2 py-1 text-left text-[12px] transition-colors ${
                entry.id === viewing
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
          <button
            type="button"
            onClick={() => onSelect(ROTATE_PROVIDER, '')}
            className="glass-ghost shrink-0 border-b border-line-soft px-3 py-2 text-left text-[12px] text-text hover:text-brand"
          >
            {provider === ROTATE_PROVIDER ? 'Using Rotate usage' : 'Use Rotate usage for this session'}
          </button>
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
                  title={choice.id === (group?.id ?? null) ? `${choice.name}, in use` : `Rotate over ${choice.name}`}
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
                  title={entry.unavailableReason ?? entry.outOfUsage?.reason}
                >
                  {entry.unavailableReason
                    ? 'unavailable'
                    : !entry.ready
                    ? 'no key'
                    : entry.outOfUsage !== null
                      ? 'out of usage'
                      : compactTokens(entry.inputTokens + entry.outputTokens)}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <input
            value={query}
            disabled={viewing === ''}
            autoFocus
            placeholder="Search models, or type an id"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose()
              if (event.key === 'Enter' && typedIsNew) onSelect(viewing, query.trim())
            }}
            className="border-b border-line-soft bg-transparent px-3 py-1.5 text-[12px] text-text outline-none placeholder:text-faint"
          />

          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {matches.length === 0 && (
              <div data-picker-empty className="px-2 py-3 text-[12px] leading-relaxed text-faint">
                {viewing === ''
                  ? 'No providers shown. Turn on Composer in Settings → Providers or Auth provider.'
                  : query.trim() === ''
                  ? `No ${providerLabel} models chosen yet. Choose the ones you want in Settings → Models.`
                  : picked.length === 0
                    ? 'No matches. Press Enter to use this id; this provider has no configured model list.'
                    : 'No matching configured model. Add a new id in Settings → Models first.'}
              </div>
            )}

            {typedIsNew && matches.length > 0 && (
              <button
                type="button"
                onClick={() => onSelect(viewing, query.trim())}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[11.5px] text-dim transition-colors hover:bg-hover hover:text-brand"
              >
                Add and use: {query.trim()}
              </button>
            )}

            {matches.map((id) => (
              <button
                key={id}
                data-picker-model={id}
                type="button"
                disabled={manualRoute(id).reason !== null}
                title={manualRoute(id).reason ?? undefined}
                onClick={() => onSelect(manualRoute(id).provider, id)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[11.5px] transition-colors hover:bg-hover hover:text-brand ${
                  current(id) ? 'text-text' : 'text-dim'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{id}</span>
                {manualRoute(id).reason && <span className="shrink-0 text-faint">unavailable</span>}
                {freeClineAccount && <span className="shrink-0 text-faint">free</span>}
                {current(id) && <span className="shrink-0">✓</span>}
              </button>
            ))}
          </div>

          {picked.length > 0 && (
            <div className="truncate border-t border-line-soft px-3 py-1.5 text-[11px] text-faint">
              {providerLabel} · {picked.length} models
            </div>
          )}
        </>
      )}
    </div>
  )
}
