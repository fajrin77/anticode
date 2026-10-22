import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AccessObservation, AccessProbeResult, AccessReport as Report, AccessSource, AccessState } from '@shared/ipc'

const LABELS: Record<AccessState, string> = {
  ready: 'Pernah berhasil', unknown: 'Belum teruji', quota: 'Habis kuota', auth: 'Login/key ditolak', restricted: 'Akses ditolak', cooldown: 'Cooldown', 'request-limit': 'Batas request', retry: 'Waktunya coba ulang', limited: 'Terbatas per model'
}
const BLOCKED = new Set<AccessState>(['quota', 'auth', 'restricted', 'cooldown'])
function active(mark: AccessObservation, now: number): boolean { return !mark.retryAt || mark.retryAt > now }
function stateFor(row: AccessSource, model: string, now: number): AccessState {
  if (!model) return row.state
  const mark = row.observations.filter(item => (item.scope === 'account' || item.model === model) && active(item, now)).sort((a,b) => b.checkedAt - a.checkedAt)[0]
  return mark?.state ?? (row.state === 'auth' ? 'auth' : row.lastSuccessAt ? 'ready' : 'unknown')
}
const time = (value: number): string => new Date(value).toLocaleString()

export function AccessReport(): JSX.Element {
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState(false)
  const [models, setModels] = useState<Record<string, string>>({})
  const [tests, setTests] = useState<Record<string, AccessProbeResult>>({})
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const testAll = async (): Promise<void> => {
    setTesting(true)
    setTestError(null)
    try {
      const results = await window.anticode.testAllAccess()
      setTests(Object.fromEntries(results.map(result => [result.id, result])))
      setReport(await window.anticode.getAccessReport())
    } catch (failure) {
      setTestError((failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally { setTesting(false) }
  }
  useEffect(() => {
    let alive = true
    const update = (): void => { void window.anticode.getAccessReport().then(data => { if (alive) { setReport(data); setError(false) } }).catch(() => { if (alive) setError(true) }) }
    update()
    const timer = setInterval(update, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  return (
    <div className="glass-surface mt-4 overflow-hidden rounded-xl border border-line" data-access-report>
      <div className="border-b border-line-soft px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[13px] text-text">Status akun &amp; API key</h2>
          <button type="button" disabled={testing} onClick={() => void testAll()}
            title="Kirim satu pesan kecil lewat setiap akun dan API key"
            className="glass-control w-[104px] shrink-0 rounded-lg border px-3 py-1.5 text-center text-[12px] text-text transition-colors enabled:hover:text-brand disabled:text-faint">
            {testing ? 'Menguji…' : 'Tes semua'}
          </button>
        </div>
        {testError !== null && <p role="status" className="mt-2 text-[12px] text-del">{testError}</p>}
      </div>
      {error && <p role="status" className="px-4 py-3 text-[12px] text-del">Laporan tidak dapat diperbarui.</p>}
      {!report && !error && <p className="px-4 py-3 text-[12px] text-faint">Loading account status…</p>}
      {report?.groups.length === 0 && <p className="px-4 py-3 text-[12px] text-faint">Belum ada akun atau API key tersimpan.</p>}
      {report?.groups.map(group => {
        const model = models[group.id] ?? ''
        const choices = [...new Set(group.sources.flatMap(row => row.observations.map(mark => mark.model).filter(Boolean)))].sort()
        const states = group.sources.map(row => stateFor(row, model, report.checkedAt))
        const count = (...match: AccessState[]): number => states.filter(state => match.includes(state)).length
        const usable = states.length - states.filter(state => BLOCKED.has(state)).length
        const tested = group.sources.map(row => tests[row.id]).filter((result): result is AccessProbeResult => result !== undefined)
        const facts = [
          { text: `tes: ${tested.filter(result => result.ok).length} OK · ${tested.filter(result => !result.ok).length} gagal`, tone: tested.some(result => !result.ok) ? 'text-del' : 'text-dim', show: tested.length > 0 },
          { text: `${usable} bisa dipakai`, tone: 'text-dim' },
          { text: `${count('quota')} habis kuota`, tone: 'text-del', show: count('quota') > 0 },
          { text: `${count('auth', 'restricted')} ditolak`, tone: 'text-del', show: count('auth', 'restricted') > 0 },
          { text: `${count('cooldown')} cooldown`, tone: 'text-faint', show: count('cooldown') > 0 },
          { text: `${count('unknown')} belum teruji`, tone: 'text-faint', show: count('unknown') > 0 }
        ].filter(fact => fact.show !== false)
        return (
          <details key={group.id} data-access-group={group.id} className="border-b border-line-soft last:border-b-0">
            <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-[12.5px] text-text transition-colors hover:text-brand">
              <span>{group.label}</span>
              <span className="text-[11.5px] tabular-nums text-faint">{group.sources.length} {group.kind === 'keys' ? 'API key' : 'akun'}{model ? ' · model ini' : ''}</span>
              <span className="ml-auto flex flex-wrap gap-x-3 text-[11.5px] tabular-nums">{facts.map(fact => <span key={fact.text} className={fact.tone}>{fact.text}</span>)}</span>
            </summary>
            <div className="border-t border-line-soft px-4 py-3">
              {choices.length > 0 && <label className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-faint">Model
                <select aria-label={`Status model ${group.label}`} value={model} onChange={event => setModels(current => ({ ...current, [group.id]: event.target.value }))} className="max-w-full rounded-md border border-line bg-surface px-2 py-1 text-text">
                  <option value="">Semua model / status akun</option>
                  {choices.map(id => <option key={id} value={id}>{id}</option>)}
                </select>
              </label>}
              <div className="space-y-3">{group.sources.map(row => {
                const state = stateFor(row, model, report.checkedAt)
                const observations = row.observations.filter(mark => !model || mark.scope === 'account' || mark.model === model)
                return <div key={row.id} data-access-source={row.id} className="rounded-lg border border-line-soft px-3 py-2">
                  <div className="flex flex-wrap items-start justify-between gap-2 text-[12px]">
                    <span className="min-w-0 break-all text-text">{row.label}</span>
                    <span className={BLOCKED.has(state) ? 'text-del' : 'text-dim'}>{LABELS[state]}</span>
                  </div>
                  {tests[row.id] && <p data-access-test={tests[row.id]!.ok ? 'ok' : 'fail'} className={`mt-1 break-words text-[11px] ${tests[row.id]!.ok ? 'text-dim' : 'text-del'}`}>
                    Tes {tests[row.id]!.model}: {tests[row.id]!.ok ? `OK · ${(tests[row.id]!.ms / 1000).toFixed(1)} dtk` : `gagal${tests[row.id]!.status ? ` (HTTP ${tests[row.id]!.status})` : ''} · ${tests[row.id]!.message ?? ''}`}
                  </p>}
                  {row.lastSuccessAt && <p className="mt-1 text-[11px] text-faint">Terakhir berhasil: {time(row.lastSuccessAt)}</p>}
                  {observations.map((mark, index) => <p key={`${mark.model}-${mark.scope}-${index}`} className="mt-1 break-words text-[11px] text-faint">
                    {LABELS[mark.state]} · {mark.scope === 'account' ? 'seluruh akun/key' : mark.model} · {time(mark.checkedAt)}{mark.retryAt ? ` · coba ulang ${time(mark.retryAt)}` : mark.state === 'quota' ? ' · waktu reset belum diketahui' : ''}{!active(mark, report.checkedAt) ? ' · menunggu verifikasi ulang' : ''}
                  </p>)}
                </div>
              })}</div>
            </div>
          </details>
        )
      })}
    </div>
  )
}
