import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc'
import { SettingRow } from './controls'

/** Read-only permission checks never trigger a macOS permission prompt. */
export function Capabilities() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = () => {
    void window.anticode.getAppInfo().then(value => { setInfo(value); setError(null) })
      .catch((failure: Error) => setError(failure.message))
  }
  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  return (
    <section className="mb-8" aria-label="Computer use capabilities">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[14px] text-text">Tools and computer use</h2>
        <button type="button" onClick={refresh} className="glass-ghost rounded-md px-2 py-1 text-[12px] text-dim transition-colors hover:text-brand">Refresh permissions</button>
      </div>
      <div className="glass-surface overflow-hidden rounded-xl border border-line">
        <SettingRow title="antichat" hint="File, terminal, web search, browser, internet, image generation, screenshot and MCP tools run in a private folder owned by each session; no project selection is required.">All tools · private folder</SettingRow>
        <SettingRow title="anticode" hint="The same tools run in the project folder selected when the session is created.">All tools · project folder</SettingRow>
        <SettingRow title="Desktop app control" hint="Controlling other macOS apps requires a connected computer-use MCP server. A screen capture alone cannot click or type in another app.">Requires MCP tools</SettingRow>
        <SettingRow title="Screen Recording" hint={info?.platform === 'darwin' ? 'For whole-screen screenshots: System Settings → Privacy & Security → Screen Recording. Return here to refresh after changing access.' : 'Whole-screen capture is currently available on macOS only.'}>
          {info?.screenRecording ?? 'Checking…'}
        </SettingRow>
        <SettingRow title="Accessibility" hint="Permission alone does not add desktop-control tools; check the tools exposed by your connected MCP server.">
          {info === null ? 'Checking…' : info.platform !== 'darwin' ? 'Not applicable' : info.accessibility ? 'Granted' : 'Not granted'}
        </SettingRow>
      </div>
      {error && <div role="alert" className="mt-2 text-[12px] text-del">{error}</div>}
    </section>
  )
}
