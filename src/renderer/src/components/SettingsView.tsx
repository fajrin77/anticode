import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type {
  AppInfo,
  ModelCatalogue,
  ProviderId,
  ProviderInfo,
  RemoteStatus,
  SessionStatus
} from '@shared/ipc'

interface SettingsViewProps {
  appInfo: AppInfo | null
  status: SessionStatus | null
  providers: ProviderInfo[]
  onSelectProvider: (provider: ProviderId, model: string) => void
  onToggleAutoApprove: (enabled: boolean) => void
  onProvidersChange: (providers: ProviderInfo[]) => void
  onBack: () => void
}

type Section = 'general' | 'providers' | 'models' | 'remote'

function Toggle({ on, onChange }: { on: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors ${on ? 'bg-add' : 'bg-hover'}`}
    >
      <span
        className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0'}`}
      />
    </button>
  )
}

function SettingRow({
  title,
  hint,
  children
}: {
  title: string
  hint: string
  children: JSX.Element | string
}): JSX.Element {
  return (
    <div className="flex items-center gap-6 border-b border-line-soft px-5 py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] text-text">{title}</div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-faint">{hint}</div>
      </div>
      <div className="shrink-0 text-[13px] text-dim">{children}</div>
    </div>
  )
}

function Tag({ children }: { children: string }): JSX.Element {
  return (
    <span className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-faint">
      {children}
    </span>
  )
}

function General({
  status,
  appInfo,
  onToggleAutoApprove
}: {
  status: SessionStatus | null
  appInfo: AppInfo | null
  onToggleAutoApprove: (enabled: boolean) => void
}): JSX.Element {
  /* rows below */
  const rows: [string, string][] = appInfo
    ? [
        ['Version', appInfo.version],
        ['Electron', appInfo.electron],
        ['Node', appInfo.node],
        ['Platform', appInfo.platform],
        ['Workspace', status?.workspaceRoot ?? 'not selected']
      ]
    : [['Workspace', status?.workspaceRoot ?? 'not selected']]

  return (
    <>
      <h1 className="mb-6 text-[19px] text-text">General</h1>

      <div className="mb-8 overflow-hidden rounded-xl border border-line">
        <SettingRow
          title="Auto-accept permissions"
          hint="All tool calls run without asking — file edits, shell, everything"
        >
          <Toggle on={status?.autoApprove === true} onChange={onToggleAutoApprove} />
        </SettingRow>
        <SettingRow title="Provider" hint="The gateway anticode talks to">
          {status?.provider ?? '—'}
        </SettingRow>
        <SettingRow title="Model" hint="Model used for new turns in every session">
          <span className="font-mono text-[12.5px]">{status?.model || 'not set'}</span>
        </SettingRow>
      </div>

      <h2 className="mb-3 text-[15px] text-text">Runtime</h2>
      <div className="overflow-hidden rounded-xl border border-line">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-baseline justify-between gap-6 border-b border-line-soft px-5 py-3 last:border-b-0"
          >
            <span className="text-[12.5px] text-faint">{label}</span>
            <span className="min-w-0 truncate font-mono text-[12.5px] text-dim">{value}</span>
          </div>
        ))}
      </div>
    </>
  )
}

function Providers({
  providers,
  status,
  onSelectProvider,
  onProvidersChange
}: {
  providers: ProviderInfo[]
  status: SessionStatus | null
  onSelectProvider: (provider: ProviderId, model: string) => void
  onProvidersChange: (providers: ProviderInfo[]) => void
}): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<'openai' | 'ollama'>('openai')
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  const valid =
    label.trim() !== '' &&
    baseURL.trim() !== '' &&
    (kind === 'ollama' || apiKey.trim() !== '')

  function add(): void {
    if (!valid) return
    void window.anticode
      .addProvider({ label, kind, baseURL, apiKey })
      .then((next) => {
        onProvidersChange(next)
        // Switch straight to the freshly added provider and prefetch its
        // model catalogue, so its models are immediately usable.
        const added = next.find((entry) => !providers.some((old) => old.id === entry.id))
        if (added !== undefined) onSelectProvider(added.id, '')
        setAdding(false)
        setLabel('')
        setBaseURL('')
        setApiKey('')
        setError(null)
      })
      .catch((failure) => setError((failure as Error).message))
  }

  function remove(id: string): void {
    void window.anticode.removeProvider(id).then(onProvidersChange)
  }

  const inputClass =
    'w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-text outline-none placeholder:text-faint focus:border-hover'

  return (
    <>
      <h1 className="mb-6 text-[19px] text-text">Providers</h1>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[14px] text-text">Connected providers</h2>
        <button
          type="button"
          onClick={() => setAdding((value) => !value)}
          className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-dim transition-colors hover:bg-raised hover:text-text"
        >
          + Add provider
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        {providers.map((provider) => {
          const active = provider.id === status?.provider
          const custom = provider.id.startsWith('custom:')
          return (
            <div
              key={provider.id}
              className="flex items-center gap-3 border-b border-line-soft px-5 py-4 last:border-b-0"
            >
              <span className={`text-[13.5px] ${active ? 'text-text' : 'text-dim'}`}>
                {provider.label}
              </span>
              {provider.credentialAvailable ? (
                custom && provider.credentialHint === 'Local endpoint' ? <Tag>Local</Tag> : <Tag>API key</Tag>
              ) : (
                <Tag>needs key</Tag>
              )}
              <span className="ml-auto text-[12px] text-faint">
                {provider.credentialAvailable
                  ? active
                    ? 'active'
                    : 'ready'
                  : provider.credentialHint}
              </span>
              {custom && (
                <button
                  type="button"
                  onClick={() => remove(provider.id)}
                  className="shrink-0 text-[12px] text-faint transition-colors hover:text-del"
                >
                  Remove
                </button>
              )}
            </div>
          )
        })}
      </div>

      {adding && (
        <div className="mt-4 rounded-xl border border-line p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2">
              <span className="mb-1 block text-[12px] text-faint">Name</span>
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="OpenRouter, LM Studio, …"
                className={inputClass}
              />
            </label>
            <label className="col-span-2">
              <span className="mb-1 block text-[12px] text-faint">Type</span>
              <div className="flex rounded-lg border border-line p-0.5">
                {(
                  [
                    { value: 'openai', label: 'OpenAI-compatible (cloud)' },
                    { value: 'ollama', label: 'Local server (Ollama, LM Studio)' }
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setKind(option.value)}
                    className={`flex-1 rounded-md px-2 py-1.5 text-[12.5px] transition-colors ${
                      kind === option.value ? 'bg-hover text-text' : 'text-dim hover:text-text'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </label>
            <label className="col-span-2">
              <span className="mb-1 block text-[12px] text-faint">Base URL</span>
              <input
                value={baseURL}
                onChange={(event) => setBaseURL(event.target.value)}
                placeholder={
                  kind === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://api.example.com/v1'
                }
                className={inputClass}
              />
            </label>
            {kind === 'openai' && (
              <label className="col-span-2">
                <span className="mb-1 block text-[12px] text-faint">API key</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="sk-…"
                  className={inputClass}
                />
              </label>
            )}
          </div>

          {error !== null && (
            <p className="mt-2 text-[12px] text-del">{error}</p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="rounded-lg px-3 py-2 text-[12.5px] text-dim transition-colors hover:bg-raised hover:text-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={add}
              disabled={!valid}
              className="rounded-lg bg-hover px-4 py-2 text-[12.5px] text-text transition-colors hover:bg-[#3a3a3a] disabled:cursor-not-allowed disabled:text-faint"
            >
              Add provider
            </button>
          </div>
        </div>
      )}

      <p className="mt-3 text-[12px] leading-relaxed text-faint">
        Custom providers speak the OpenAI-compatible <span className="font-mono">/v1</span> format.
        Keys are stored locally in the app data directory and never sent anywhere except the
        endpoint you configure. The built-in Clinepass key still comes from{' '}
        <span className="font-mono">.env</span>.
      </p>
    </>
  )
}

function Models({
  status,
  onSelectProvider
}: {
  status: SessionStatus | null
  onSelectProvider: (provider: ProviderId, model: string) => void
}): JSX.Element {
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null)
  const [query, setQuery] = useState('')

  const provider = status?.provider ?? 'clinepass'

  useEffect(() => {
    let active = true
    void window.anticode.listModels(provider).then((result) => {
      if (active) setCatalogue(result)
    })
    return () => {
      active = false
    }
  }, [provider])

  const needle = query.trim().toLowerCase()
  const matches =
    catalogue?.models.filter((id) => needle === '' || id.toLowerCase().includes(needle)) ?? []

  return (
    <>
      <h1 className="mb-6 text-[19px] text-text">Models</h1>

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search models"
        className="mb-4 w-full rounded-lg border border-line bg-surface px-4 py-2.5 text-[13.5px] text-text outline-none placeholder:text-faint focus:border-hover"
      />

      <div className="overflow-hidden rounded-xl border border-line">
        {matches.map((id) => {
          const active = id === status?.model
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelectProvider(provider, id)}
              className={`flex w-full items-center gap-3 border-b border-line-soft px-5 py-3.5 text-left transition-colors last:border-b-0 ${
                active ? 'bg-raised' : 'hover:bg-raised'
              }`}
            >
              <span className={`min-w-0 truncate font-mono text-[13px] ${active ? 'text-text' : 'text-dim'}`}>
                {id}
              </span>
              {active && <span className="ml-auto shrink-0 text-[11.5px] text-faint">active</span>}
            </button>
          )
        })}
        {matches.length === 0 && (
          <div className="px-5 py-4 text-[12.5px] text-faint">
            {catalogue === null ? 'Loading models…' : 'No models match.'}
          </div>
        )}
      </div>
    </>
  )
}

function Remote(): JSX.Element {
  const [remote, setRemote] = useState<RemoteStatus | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void window.anticode.getRemoteStatus().then(setRemote)
  }, [])

  function toggle(enabled: boolean): void {
    void window.anticode.setRemoteEnabled(enabled).then(setRemote)
  }

  return (
    <>
      <h1 className="mb-6 text-[19px] text-text">Remote</h1>

      <div className="overflow-hidden rounded-xl border border-line">
        <SettingRow
          title="Remote access"
          hint="Control anticode from a phone browser on the same Wi-Fi"
        >
          <Toggle on={remote?.enabled === true} onChange={toggle} />
        </SettingRow>
      </div>

      {remote?.enabled === true && remote.url !== null && (
        <>
          <h2 className="mb-3 mt-8 text-[14px] text-text">Pairing</h2>
          <div className="rounded-xl border border-line p-4">
            <div className="mb-2 text-[12px] text-faint">Open this URL on the phone, then use “Add to Home Screen” for an app-like icon:</div>
            <div className="mb-3 break-all rounded-lg bg-surface px-3 py-2 font-mono text-[12px] text-code select-all">
              {remote.url}
            </div>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(remote.url ?? '').then(() => {
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1500)
                })
              }}
              className="rounded-lg bg-hover px-3 py-1.5 text-[12.5px] text-text transition-colors hover:bg-[#3a3a3a]"
            >
              {copied ? 'Copied' : 'Copy URL'}
            </button>
          </div>
        </>
      )}

      <div className="mt-8 rounded-xl border border-line-soft p-4 text-[12px] leading-relaxed text-faint">
        <p className="mb-2">Requirements and limits:</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>The Mac must stay awake — closing the lid sleeps the app (System Settings → Battery → Power Adapter → prevent automatic sleeping, or run <span className="font-mono">caffeinate -s</span>).</li>
          <li>The phone and the Mac share the Wi-Fi. For access away from home, put both on Tailscale.</li>
          <li>Remote prompts follow the desktop approval mode. Enable Auto in General for fully unattended runs.</li>
          <li>Sessions created remotely appear on the desktop after it restarts.</li>
        </ul>
      </div>
    </>
  )
}

export function SettingsView({
  appInfo,
  status,
  providers,
  onSelectProvider,
  onToggleAutoApprove,
  onProvidersChange,
  onBack
}: SettingsViewProps): JSX.Element {
  const [section, setSection] = useState<Section>('general')

  const items: { id: Section; label: string; icon: JSX.Element }[] = [
    {
      id: 'general',
      label: 'General',
      icon: (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M2 4.5h5.6M11.4 4.5H14M2 11.5h1.6M7.4 11.5H14" strokeLinecap="round" />
          <circle cx="9.5" cy="4.5" r="1.9" />
          <circle cx="5.4" cy="11.5" r="1.9" />
        </svg>
      )
    },
    {
      id: 'providers',
      label: 'Providers',
      icon: (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="2" y="2.5" width="12" height="4.5" rx="1.2" />
          <rect x="2" y="9" width="12" height="4.5" rx="1.2" />
          <circle cx="11" cy="4.75" r="0.4" fill="currentColor" />
          <circle cx="11" cy="11.25" r="0.4" fill="currentColor" />
        </svg>
      )
    },
    {
      id: 'models',
      label: 'Models',
      icon: (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M8 1.8l1.4 3.6 3.8.2-3 2.4 1 3.7L8 9.6l-3.2 2.1 1-3.7-3-2.4 3.8-.2z" strokeLinejoin="round" />
        </svg>
      )
    },
    {
      id: 'remote',
      label: 'Remote',
      icon: (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="1.5" y="3" width="8" height="6" rx="1.2" />
          <rect x="6.5" y="7" width="8" height="6" rx="1.2" />
        </svg>
      )
    }
  ]

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-56 shrink-0 flex-col border-r border-line-soft px-3 pt-8 pb-6">
        <div className="mb-4 px-3 text-[12px] text-faint">Desktop</div>
        <nav className="flex flex-col gap-0.5">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13.5px] transition-colors ${
                section === item.id ? 'bg-hover text-text' : 'text-dim hover:bg-raised hover:text-text'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        <button
          type="button"
          onClick={onBack}
          className="mt-auto px-3 text-left text-[12.5px] text-faint transition-colors hover:text-text"
        >
          ← Back
        </button>
        <div className="mt-2 px-3 text-[11.5px] text-faint">
          anticode {appInfo?.version ?? ''}
        </div>
      </aside>

      <div className="min-h-0 flex-1 overflow-y-auto px-10 pt-8 pb-10">
        <div className="mx-auto max-w-2xl">
          {section === 'general' && (
            <General status={status} appInfo={appInfo} onToggleAutoApprove={onToggleAutoApprove} />
          )}
          {section === 'providers' && (
            <Providers
              providers={providers}
              status={status}
              onSelectProvider={onSelectProvider}
              onProvidersChange={onProvidersChange}
            />
          )}
          {section === 'models' && <Models status={status} onSelectProvider={onSelectProvider} />}
          {section === 'remote' && <Remote />}
        </div>
      </div>
    </div>
  )
}
