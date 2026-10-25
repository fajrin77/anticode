import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Toggle } from './controls'

export function Connectors(): JSX.Element {
  const [settings, setSettings] = useState<{ codex: boolean; claude: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void window.anticode.getConnectorSettings().then(setSettings).catch((e: Error) => setError(e.message)) }, [])
  async function change(kind: 'codex' | 'claude'): Promise<void> {
    if (!settings) return
    setBusy(true)
    setError(null)
    try { setSettings(await window.anticode.setConnectorSettings({ ...settings, [kind]: !settings[kind] })) }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  return <section className="glass-surface mb-6 rounded-xl border border-line p-5" data-connectors>
    <h2 className="text-[13.5px] text-text">Connector</h2>
    <p className="mt-1 text-[11.5px] leading-relaxed text-faint">Share connected apps with every model. Changes apply to subsequent tool calls in running sessions. Enable either, both, or neither.</p>
    {(['codex', 'claude'] as const).map((kind) => <div key={kind} className="mt-4 flex items-center justify-between gap-4">
      <span className="text-[12.5px] text-text">{kind === 'codex' ? 'ChatGPT' : 'Claude'}</span>
      <Toggle label={`${kind === 'codex' ? 'ChatGPT' : 'Claude'} connectors`} on={settings?.[kind] ?? false} disabled={busy || settings === null} onChange={() => void change(kind)} />
    </div>)}
    <p className="mt-3 text-[11px] text-faint">Connect apps in ChatGPT → Apps or claude.ai first. Your model and inference account do not change.</p>
    {error && <p role="alert" className="mt-2 text-[12px] text-del">{error}</p>}
  </section>
}
