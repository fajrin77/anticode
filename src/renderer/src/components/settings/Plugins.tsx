import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { PluginAction, PluginStatus, PluginsView } from '@shared/ipc'
import { Toggle } from './controls'

function errorText(failure: unknown): string {
  return (failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

const STATE_TEXT: Record<PluginStatus['state'], string> = { off: 'not connected', connecting: 'connecting…', ready: 'connected', error: 'failed' }
const METHOD_TEXT = { oauth: 'OAuth', device: 'GitHub OAuth', token: 'token' } as const
const field = 'glass-field rounded-lg border px-3 py-1.5 text-[12.5px] text-text outline-none placeholder:text-faint'
const link = 'rounded-md px-2 py-1 text-[12px] text-dim transition-colors hover:text-brand disabled:text-faint disabled:hover:text-faint'

function PluginRow({ plugin, view, run }: { plugin: PluginStatus; view: PluginsView; run: (action: PluginAction) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [clientId, setClientId] = useState(view.githubClientId)
  const [confirming, setConfirming] = useState<string | null>(null)
  const signingIn = view.login?.plugin === plugin.id
  const busy = view.login !== null
  const add = (): void => run({ type: 'login', plugin: plugin.id })

  return (
    <div className="border-b border-line-soft last:border-b-0" data-plugin={plugin.id}>
      <div className="flex items-center gap-3 px-5 py-3.5">
        <button type="button" onClick={() => setOpen(!open)} className="group min-w-0 flex-1 text-left">
          <div className="flex items-baseline gap-2">
            <span className="text-[13.5px] text-text transition-colors group-hover:text-brand">{plugin.name}</span>
            <span className={`text-[11.5px] tabular-nums ${plugin.state === 'error' ? 'text-del' : 'text-faint'}`}>
              {plugin.accounts.length === 0 ? 'no account' : STATE_TEXT[plugin.state]}
              {plugin.state === 'ready' ? ` · ${plugin.tools.length} ${plugin.tools.length === 1 ? 'tool' : 'tools'}` : ''}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-faint">{plugin.url}</div>
          {plugin.state === 'error' && plugin.error !== null && <div className="mt-1 text-[11.5px] text-del">{plugin.error}</div>}
        </button>
        {plugin.accounts.length > 0 && (
          <select
            aria-label={`${plugin.name} account`}
            value={plugin.activeAccount ?? ''}
            onChange={(event) => run({ type: 'select', plugin: plugin.id, account: event.target.value })}
            className={`${field} max-w-44 cursor-pointer transition-colors hover:text-brand`}
          >
            {plugin.accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
          </select>
        )}
        {plugin.state === 'error' && <button type="button" onClick={() => run({ type: 'reconnect', plugin: plugin.id })} className={link}>Retry</button>}
        <button
          type="button"
          disabled={busy}
          onClick={() => (plugin.auth === 'github' && view.githubClientId === '' ? setOpen(true) : add())}
          className={link}
        >
          {plugin.accounts.length === 0 ? 'Connect' : 'Add account'}
        </button>
        <Toggle on={plugin.enabled && plugin.accounts.length > 0} disabled={plugin.accounts.length === 0} onChange={(enabled) => run({ type: 'enable', plugin: plugin.id, enabled })} label={`${plugin.name} on`} />
      </div>

      {signingIn && view.login !== null && (
        <div className="flex items-center gap-3 px-5 pb-3 text-[12px] text-dim">
          <span className="min-w-0 flex-1">{view.login.message}</span>
          {view.login.code !== undefined && <span className="font-mono text-[13px] tracking-wider text-text select-all">{view.login.code}</span>}
          <button type="button" onClick={() => run({ type: 'cancel-login' })} className={link}>Cancel</button>
        </div>
      )}

      {open && (
        <div className="flex flex-col gap-3 border-t border-line-soft px-5 py-4">
          {plugin.accounts.map((account) => (
            <div key={account.id} className="flex items-center gap-2 text-[12.5px]">
              <input
                defaultValue={account.label}
                aria-label="Account name"
                onBlur={(event) => event.target.value.trim() !== account.label && event.target.value.trim() !== '' && run({ type: 'rename', account: account.id, label: event.target.value })}
                className={`${field} min-w-0 flex-1`}
              />
              <span className="w-24 shrink-0 text-[11.5px] text-faint">{METHOD_TEXT[account.method]}{account.id === plugin.activeAccount ? ' · active' : ''}</span>
              {confirming === account.id ? (
                <button type="button" onClick={() => run({ type: 'remove-account', account: account.id })} onMouseLeave={() => setConfirming(null)} className="rounded-md px-2 py-1 text-[12px] text-del transition-colors hover:text-del">
                  Remove?
                </button>
              ) : (
                <button type="button" aria-label={`Remove ${account.label}`} onClick={() => setConfirming(account.id)} className="rounded-md px-2 py-1 text-[12px] text-faint transition-colors hover:text-del">
                  ×
                </button>
              )}
            </div>
          ))}

          {plugin.auth === 'github' && (
            <>
              <div className="flex items-center gap-2">
                <input
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  placeholder="Client ID of your GitHub OAuth App (Device Flow on)"
                  className={`${field} min-w-0 flex-1 font-mono`}
                />
                <button type="button" disabled={clientId.trim() === view.githubClientId} onClick={() => run({ type: 'github-client', clientId })} className={link}>Save</button>
                <button type="button" disabled={busy || view.githubClientId === ''} onClick={add} className={link}>Sign in</button>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="Or a personal access token"
                  className={`${field} min-w-0 flex-1 font-mono`}
                />
                <button
                  type="button"
                  disabled={busy || token.trim() === ''}
                  onClick={() => { run({ type: 'login', plugin: plugin.id, token }); setToken('') }}
                  className={link}
                >
                  Use token
                </button>
              </div>
            </>
          )}

          {plugin.tools.length > 0 && (
            <ul>
              {plugin.tools.map((tool) => (
                <li key={tool.name} className="flex items-baseline gap-2 py-0.5 text-[12px]">
                  <span className="shrink-0 font-mono text-dim">{tool.name}</span>
                  {tool.destructive && <span className="shrink-0 text-[11px] text-del">destructive</span>}
                  <span className="min-w-0 truncate text-faint">{tool.description}</span>
                </li>
              ))}
            </ul>
          )}
          {plugin.custom && (
            <button type="button" onClick={() => run({ type: 'remove-custom', plugin: plugin.id })} className="self-start rounded-md px-2 py-1 text-[12px] text-faint transition-colors hover:text-del">
              Remove plugin
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Hosted MCP servers signed in with OAuth, several accounts each. The active
 * account's tools are offered to every session, whatever the model.
 */
export function Plugins(): JSX.Element {
  const [view, setView] = useState<PluginsView>({ plugins: [], githubClientId: '', login: null })
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')

  useEffect(() => {
    void window.anticode.listPlugins().then(setView)
    return window.anticode.onPlugins(setView)
  }, [])

  const run = (action: PluginAction): void => {
    setError(null)
    void window.anticode.pluginAction(action).then(setView, (failure: unknown) => {
      if (!/Login cancelled/.test(errorText(failure))) setError(errorText(failure))
    })
  }

  return (
    <>
      <h1 className="mb-2 text-[19px] text-text">Plugins</h1>
      <p className="mb-6 text-[12.5px] text-faint">
        Services signed in with OAuth. The selected account’s tools work with every model; reads run, changes ask first.
      </p>
      {error !== null && <div className="mb-3 text-[12px] text-del">{error}</div>}

      <div className="glass-surface mb-6 overflow-hidden rounded-xl border border-line">
        {view.plugins.map((plugin) => <PluginRow key={plugin.id} plugin={plugin} view={view} run={run} />)}
      </div>

      <h2 className="mb-2 text-[14px] text-text">Other MCP server with OAuth</h2>
      <div className="flex items-center gap-2">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" className={`${field} w-36`} />
        <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://mcp.example.com/mcp" className={`${field} min-w-0 flex-1 font-mono`} />
        <button
          type="button"
          disabled={name.trim() === '' || url.trim() === ''}
          onClick={() => { run({ type: 'add-custom', name, url }); setName(''); setUrl('') }}
          className="glass-control rounded-lg border px-3 py-1.5 text-[12.5px] text-text transition-colors enabled:hover:text-brand disabled:text-faint"
        >
          Add
        </button>
      </div>
    </>
  )
}
