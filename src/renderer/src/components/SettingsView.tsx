import { useEffect, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import QRCode from 'qrcode'
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
      className={`h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors ${on ? 'bg-brand' : 'glass-control border'}`}
    >
      {/* On the lime track the knob goes dark: white on lime is all but
          invisible, and dark-on-lime is what every other lime control does. */}
      <span
        className={`block h-4 w-4 rounded-full shadow transition-transform ${
          on ? 'translate-x-4 bg-bg' : 'translate-x-0 bg-white'
        }`}
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
  providers,
  onToggleAutoApprove
}: {
  status: SessionStatus | null
  providers: ProviderInfo[]
  onToggleAutoApprove: (enabled: boolean) => void
}): JSX.Element {
  return (
    <>
      <h1 className="mb-6 text-[19px] text-text">General</h1>

      <div className="glass-surface mb-8 overflow-hidden rounded-xl border border-line">
        <SettingRow
          title="Auto-accept permissions"
          hint="All tool calls run without asking — file edits, shell, everything"
        >
          <Toggle on={status?.autoApprove === true} onChange={onToggleAutoApprove} />
        </SettingRow>
        <SettingRow title="Provider" hint="The gateway anticode talks to">
          {providers.find((entry) => entry.id === status?.provider)?.label ?? status?.provider ?? '—'}
        </SettingRow>
        <SettingRow title="Model" hint="Model used for new turns in every session">
          <span className="font-mono text-[12.5px]">{status?.model || 'not set'}</span>
        </SettingRow>
      </div>
    </>
  )
}

const MODELS_PLACEHOLDER = 'moonshotai/kimi-k2\nqwen/qwen3-coder'

/** What was typed in a models box, as ids: split on lines and commas, blanks dropped. */
function modelIds(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((id) => id.trim()).filter((id) => id !== ''))]
}

/** "api.example.com/v1" from "https://api.example.com/v1" — for reading, not for use. */
function hostOf(baseURL: string | undefined): string {
  if (baseURL === undefined || baseURL === '') return ''
  try {
    const url = new URL(baseURL)
    return url.host + (url.pathname === '/' ? '' : url.pathname)
  } catch {
    return baseURL
  }
}

const inputClass =
  'glass-field w-full rounded-lg border border-line px-3 py-2 text-[13px] text-text outline-none placeholder:text-faint focus:border-hover'

type ProviderKind = 'openai' | 'ollama' | 'clinepass'

interface ProviderFormValues {
  label: string
  kind: ProviderKind
  baseURL: string
  apiKey: string
  models: string
}

/**
 * One form for adding a provider and for editing one, Clinepass included.
 * Editing never shows a saved key: the field stays empty, and empty keeps it.
 */
function ProviderForm({
  initial,
  editing,
  hasKey,
  onSubmit,
  onCancel
}: {
  initial: ProviderFormValues
  /** Editing an existing provider rather than adding one. */
  editing: boolean
  hasKey: boolean
  onSubmit: (values: ProviderFormValues) => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const [values, setValues] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<ProviderFormValues>): void => setValues((current) => ({ ...current, ...patch }))
  const needsKey = values.kind !== 'ollama' && !hasKey
  const valid =
    editing ||
    (values.label.trim() !== '' &&
      values.baseURL.trim() !== '' &&
      (!needsKey || values.apiKey.trim() !== ''))

  function submit(): void {
    if (!valid || saving) return
    setSaving(true)
    onSubmit(values)
      .catch((failure) => setError((failure as Error).message))
      .finally(() => setSaving(false))
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') onCancel()
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || event.target instanceof HTMLInputElement)) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="grid grid-cols-2 gap-3" onKeyDown={onKeyDown}>
      <label className="col-span-2 sm:col-span-1">
        <span className="mb-1 block text-[12px] text-faint">Name</span>
        <input
          value={values.label}
          autoFocus
          onChange={(event) => set({ label: event.target.value })}
          placeholder="OpenRouter, LM Studio, …"
          className={inputClass}
        />
      </label>
      {!editing ? (
        <label className="col-span-2 sm:col-span-1">
          <span className="mb-1 block text-[12px] text-faint">Type</span>
          <div className="flex rounded-lg border border-line p-0.5">
            {(
              [
                { value: 'openai', label: 'Cloud (OpenAI-compatible)' },
                { value: 'ollama', label: 'Local server' }
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => set({ kind: option.value })}
                className={`flex-1 rounded-md px-2 py-1.5 text-[12.5px] transition-colors ${
                  values.kind === option.value ? 'glass-control text-text' : 'text-dim hover:text-brand'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </label>
      ) : (
        <div className="col-span-2 sm:col-span-1" />
      )}
      <label className="col-span-2">
        <span className="mb-1 block text-[12px] text-faint">Base URL</span>
        <input
          value={values.baseURL}
          onChange={(event) => set({ baseURL: event.target.value })}
          placeholder={values.kind === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://api.example.com/v1'}
          spellCheck={false}
          className={`${inputClass} font-mono text-[12.5px]`}
        />
      </label>
      {values.kind !== 'ollama' && (
        <label className="col-span-2">
          <span className="mb-1 block text-[12px] text-faint">API key</span>
          <input
            type="password"
            value={values.apiKey}
            onChange={(event) => set({ apiKey: event.target.value })}
            placeholder={hasKey ? 'Saved — leave empty to keep it' : 'sk-…'}
            autoComplete="off"
            className={inputClass}
          />
        </label>
      )}
      <label className="col-span-2">
        <span className="mb-1 block text-[12px] text-faint">
          Models{values.kind === 'clinepass' ? '' : ' (optional)'}
        </span>
        <textarea
          value={values.models}
          rows={Math.min(Math.max(values.models.split('\n').length, 3), 8)}
          onChange={(event) => set({ models: event.target.value })}
          placeholder={MODELS_PLACEHOLDER}
          spellCheck={false}
          className={`${inputClass} resize-none font-mono text-[12.5px] leading-relaxed`}
        />
        <span className="mt-1.5 block text-[11.5px] leading-relaxed text-faint">
          {values.kind === 'clinepass'
            ? 'The subscription models, one id per line. Empty goes back to the list anticode ships with.'
            : 'One id per line. They show in the model picker even when the provider has no model list; the first is the default.'}
        </span>
      </label>

      {error !== null && <p className="col-span-2 text-[12px] text-del">{error}</p>}

      <div className="col-span-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-[12.5px] text-dim transition-colors hover:bg-raised hover:text-brand"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!valid || saving}
          className="glass-control rounded-lg border px-4 py-1.5 text-[12.5px] text-text transition-colors hover:text-brand disabled:cursor-not-allowed disabled:text-faint"
        >
          {editing ? 'Save' : 'Add provider'}
        </button>
      </div>
    </div>
  )
}

const EMPTY_FORM: ProviderFormValues = { label: '', kind: 'openai', baseURL: '', apiKey: '', models: '' }

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
  // One row at a time is open: for editing, or for confirming its removal.
  const [open, setOpen] = useState<{ id: string; action: 'edit' | 'remove' } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const clinepassRemoved = !providers.some((entry) => entry.id === 'clinepass')

  async function add(values: ProviderFormValues): Promise<void> {
    const next = await window.anticode.addProvider({
      label: values.label,
      kind: values.kind,
      baseURL: values.baseURL,
      apiKey: values.apiKey,
      models: modelIds(values.models)
    })
    onProvidersChange(next)
    // Switch straight to the freshly added provider and prefetch its model
    // catalogue, so its models are immediately usable.
    const added = next.find((entry) => !providers.some((old) => old.id === entry.id))
    if (added !== undefined && added.credentialAvailable) onSelectProvider(added.id, '')
    setAdding(false)
  }

  async function save(id: ProviderId, values: ProviderFormValues): Promise<void> {
    const next = await window.anticode.updateProvider(id, {
      label: values.label,
      baseURL: values.baseURL,
      apiKey: values.apiKey,
      models: modelIds(values.models)
    })
    onProvidersChange(next)
    setOpen(null)
  }

  function remove(id: ProviderId): void {
    void window.anticode
      .removeProvider(id)
      .then((next) => {
        onProvidersChange(next)
        setOpen(null)
        setError(null)
      })
      .catch((failure) => setError((failure as Error).message))
  }

  function restoreClinepass(): void {
    void window.anticode
      .addProvider({ label: 'Clinepass', kind: 'clinepass', baseURL: '', apiKey: '' })
      .then((next) => {
        onProvidersChange(next)
        setError(null)
        // With no key left to find, the form is where it gets one.
        const back = next.find((entry) => entry.id === 'clinepass')
        if (back !== undefined && !back.credentialAvailable) setOpen({ id: 'clinepass', action: 'edit' })
      })
      .catch((failure) => setError((failure as Error).message))
  }

  return (
    <>
      <h1 className="mb-6 text-[19px] text-text">Providers</h1>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[14px] text-text">Connected providers</h2>
        <button
          type="button"
          onClick={() => {
            setAdding((value) => !value)
            setOpen(null)
          }}
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px] transition-colors hover:text-brand ${
            adding ? 'glass-control text-text' : 'glass-control border-line text-dim'
          }`}
        >
          + Add provider
        </button>
      </div>

      {adding && (
        <div className="glass-surface mb-4 rounded-xl border border-line p-4">
          <ProviderForm
            initial={EMPTY_FORM}
            editing={false}
            hasKey={false}
            onSubmit={add}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      <div className="glass-surface overflow-hidden rounded-xl border border-line">
        {providers.map((provider) => {
          const active = provider.id === status?.provider
          const kind: ProviderKind = provider.kind ?? 'openai'
          const listed = provider.models ?? []
          const editingThis = open?.id === provider.id && open.action === 'edit'
          const removingThis = open?.id === provider.id && open.action === 'remove'
          const details = [
            hostOf(provider.baseURL) || 'no base URL',
            kind === 'ollama' ? 'local' : provider.hasKey === true ? 'key saved' : 'no key',
            listed.length > 0 ? `${listed.length} ${listed.length === 1 ? 'model' : 'models'}` : null
          ].filter((part) => part !== null)
          return (
            <div key={provider.id} className="border-b border-line-soft last:border-b-0">
              <div className="flex items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`truncate text-[13.5px] ${active ? 'text-text' : 'text-dim'}`}>
                      {provider.label}
                    </span>
                    {kind === 'clinepass' && <Tag>built-in</Tag>}
                    {active && <span className="text-[11.5px] text-brand">active</span>}
                    {!provider.credentialAvailable && <Tag>needs key</Tag>}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11.5px] text-faint">
                    {details.join(' · ')}
                  </div>
                </div>
                {!active && provider.credentialAvailable && !removingThis && (
                  <button
                    type="button"
                    title={`Use ${provider.label}`}
                    onClick={() => onSelectProvider(provider.id, '')}
                    className="shrink-0 rounded-md px-2 py-1 text-[12px] text-faint transition-colors hover:bg-raised hover:text-brand"
                  >
                    Use
                  </button>
                )}
                {removingThis ? (
                  <>
                    <span className="shrink-0 text-[12px] text-dim">Remove?</span>
                    <button
                      type="button"
                      onClick={() => setOpen(null)}
                      className="shrink-0 rounded-md px-2 py-1 text-[12px] text-faint transition-colors hover:bg-raised hover:text-brand"
                    >
                      Keep
                    </button>
                    <button
                      type="button"
                      title={`Confirm removing ${provider.label}`}
                      onClick={() => remove(provider.id)}
                      className="shrink-0 rounded-md px-2 py-1 text-[12px] text-del transition-colors hover:bg-raised"
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      title={`Edit ${provider.label}`}
                      onClick={() => {
                        setOpen(editingThis ? null : { id: provider.id, action: 'edit' })
                        setAdding(false)
                      }}
                      className={`shrink-0 rounded-md px-2 py-1 text-[12px] transition-colors hover:bg-raised hover:text-brand ${
                        editingThis ? 'text-text' : 'text-faint'
                      }`}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      title={`Remove ${provider.label}`}
                      onClick={() => setOpen({ id: provider.id, action: 'remove' })}
                      className="shrink-0 rounded-md px-2 py-1 text-[12px] text-faint transition-colors hover:bg-raised hover:text-del"
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
              {removingThis && kind === 'clinepass' && (
                <p className="px-5 pb-3 text-[11.5px] leading-relaxed text-faint">
                  What Settings saved for Clinepass is forgotten. A key in the .env file stays
                  there, and Restore Clinepass brings it back.
                </p>
              )}
              {editingThis && (
                <div className="border-t border-line-soft px-5 py-4">
                  <ProviderForm
                    initial={{
                      label: provider.label,
                      kind,
                      baseURL: provider.baseURL ?? '',
                      apiKey: '',
                      models: listed.join('\n')
                    }}
                    editing
                    hasKey={provider.hasKey === true}
                    onSubmit={(values) => save(provider.id, values)}
                    onCancel={() => setOpen(null)}
                  />
                </div>
              )}
            </div>
          )
        })}
        {providers.length === 0 && (
          <div className="px-5 py-4 text-[12.5px] text-faint">No providers. Add one to start a session.</div>
        )}
      </div>

      {error !== null && <p className="mt-2 text-[12px] text-del">{error}</p>}

      {clinepassRemoved && (
        <button
          type="button"
          onClick={restoreClinepass}
          className="mt-3 text-[12px] text-faint transition-colors hover:text-brand"
        >
          Restore Clinepass
        </button>
      )}
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
        className="glass-field mb-4 w-full rounded-lg border border-line px-4 py-2.5 text-[13.5px] text-text outline-none placeholder:text-faint focus:border-hover"
      />

      <div className="glass-surface overflow-hidden rounded-xl border border-line">
        {matches.map((id) => {
          const active = id === status?.model
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelectProvider(provider, id)}
              className={`group flex w-full items-center gap-3 border-b border-line-soft px-5 py-3.5 text-left transition-colors last:border-b-0 ${
                active ? 'glass-control' : 'hover:bg-raised'
              }`}
            >
              <span
                className={`min-w-0 truncate font-mono text-[13px] transition-colors ${
                  active ? 'text-text' : 'text-dim group-hover:text-brand'
                }`}
              >
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
  const [qr, setQr] = useState<string | null>(null)

  useEffect(() => {
    void window.anticode.getRemoteStatus().then(setRemote)
  }, [])

  useEffect(() => {
    if (remote?.url === null || remote?.url === undefined) {
      setQr(null)
      return
    }
    void QRCode.toDataURL(remote.url, { margin: 1, width: 320 }).then(setQr)
  }, [remote?.url])

  function toggle(enabled: boolean): void {
    void window.anticode.setRemoteEnabled(enabled).then(setRemote)
  }

  function regenerate(): void {
    void window.anticode.regenerateRemoteToken().then(setRemote)
  }

  return (
    <>
      <h1 className="mb-6 text-[19px] text-text">Remote</h1>
      {remote?.error && <p role="alert" className="mb-4 text-del">{remote.error}</p>}

      <div className="glass-surface overflow-hidden rounded-xl border border-line">
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
          <div className="glass-surface rounded-xl border border-line p-4">
            <div className="flex items-start gap-4">
              {qr !== null && (
                <img
                  src={qr}
                  alt="Pairing QR code"
                  className="shrink-0 rounded-lg bg-white p-1.5"
                  width={128}
                  height={128}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="mb-2 text-[12px] text-faint">
                  Scan the QR code with the phone camera, or open this URL — then use “Add to
                  Home Screen” for an app-like icon:
                </div>
                <div className="glass-field mb-3 break-all rounded-lg border px-3 py-2 font-mono text-[12px] text-text select-all">
                  {remote.url}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(remote.url ?? '').then(() => {
                        setCopied(true)
                        window.setTimeout(() => setCopied(false), 1500)
                      })
                    }}
                    className="glass-control rounded-lg border px-3 py-1.5 text-[12.5px] text-text transition-colors hover:text-brand"
                  >
                    {copied ? 'Copied' : 'Copy URL'}
                  </button>
                  <button
                    type="button"
                    onClick={regenerate}
                    title="Invalidate the current link and issue a fresh one"
                    className="rounded-lg px-3 py-1.5 text-[12.5px] text-dim transition-colors hover:bg-hover hover:text-brand"
                  >
                    New pairing link
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
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
      <aside className="glass-surface flex w-56 shrink-0 flex-col border-r border-line-soft px-3 pt-8 pb-6">
        <div className="mb-4 px-3 text-[12px] text-faint">Desktop</div>
        <nav className="flex flex-col gap-0.5">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13.5px] transition-colors ${
                section === item.id ? 'glass-control border text-text' : 'text-dim hover:bg-raised hover:text-brand'
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
          className="mt-auto px-3 text-left text-[12.5px] text-faint transition-colors hover:text-brand"
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
            <General status={status} providers={providers} onToggleAutoApprove={onToggleAutoApprove} />
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
