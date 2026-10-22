import { useState } from 'react'
import type { JSX } from 'react'
import type { ProviderInfo } from '@shared/ipc'
import { Toggle } from './controls'

export function ComposerGroupVisibility({ members, label, onChange }: { members: ProviderInfo[]; label: string; onChange: (providers: ProviderInfo[]) => void }): JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kind = members[0]?.authKind
  if (!kind) return null
  const enabled = members.filter(p => p.composerVisible === true).length
  async function change(visible: boolean): Promise<void> {
    setBusy(true); setError(null)
    try { onChange(await window.anticode.setProviderGroupVisibility(kind!, visible)) }
    catch { setError('Tidak dapat mengubah grup') }
    finally { setBusy(false) }
  }
  return <div className="flex shrink-0 items-center gap-2">
    {error && <span role="alert" className="text-[11px] text-del">{error}</span>}
    <span className="text-[11.5px] text-faint">Composer{enabled > 0 && enabled < members.length ? ` ${enabled}/${members.length}` : ''}</span>
    <Toggle triState on={enabled === members.length} mixed={enabled > 0 && enabled < members.length} disabled={busy}
      onChange={visible => { void change(visible) }} label={`Show all ${label} accounts in composer`} data-composer-group={kind} />
  </div>
}

export function ComposerVisibility({ provider, onChange }: {
  provider: ProviderInfo
  onChange: (providers: ProviderInfo[]) => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function change(visible: boolean): Promise<void> {
    setBusy(true)
    setError(null)
    try { onChange(await window.anticode.setProviderVisibility(provider.id, visible)) }
    catch (failure) { setError((failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
    finally { setBusy(false) }
  }
  return (
    <div className="flex shrink-0 items-center gap-2">
      {error && <span role="alert" title={error} className="max-w-32 truncate text-[11px] text-del">{error}</span>}
      <span className="text-[11.5px] text-faint">Composer</span>
      <Toggle on={provider.composerVisible === true} onChange={(value) => { void change(value) }} disabled={busy}
        label={`Show ${provider.label} in composer`} title="Show in composer" data-composer-provider={provider.id} />
    </div>
  )
}
