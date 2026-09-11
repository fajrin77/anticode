import { useEffect, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import QRCode from 'qrcode'
import { modelLabel, ROTATE_PROVIDER, VENDOR_BASE_URLS } from '@shared/ipc'
import type {
  AppInfo,
  AppPreferences,
  ProviderKind,
  ModelCatalogue,
  ProviderId,
  ProviderInfo,
  RemoteStatus,
  RotationEntry,
  RotationEntryStatus,
  RotationGroupInput,
  SessionStatus
} from '@shared/ipc'
import { compactTokens } from './ModelPicker'
import { SettingRow, Toggle } from './settings/controls'
import { Updates } from './settings/Updates'
import { Pricing } from './settings/Pricing'
import { Mcp } from './settings/Mcp'
import { InstructionsField } from './InstructionsField'
import { Credentials } from './settings/Credentials'

interface SettingsViewProps {
  appInfo: AppInfo | null
  status: SessionStatus | null
  providers: ProviderInfo[]
  onSelectProvider: (provider: ProviderId, model: string) => void
  onToggleAutoApprove: (enabled: boolean) => void
  onProvidersChange: (providers: ProviderInfo[]) => void
  onBack: () => void
}

type Section = 'general' | 'providers' | 'models' | 'pricing' | 'mcp' | 'remote' | 'updates'

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
  const [preferences, setPreferences] = useState<AppPreferences | null>(null)
  useEffect(() => {
    void window.anticode.getPreferences().then(setPreferences)
    return window.anticode.onPreferences(setPreferences)
  }, [])
  const change = (patch: Partial<AppPreferences>): void => {
    void window.anticode.setPreferences(patch).then(setPreferences)
  }

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
        <SettingRow title="Provider" hint="The gateway new sessions talk to">
          {status?.provider === ROTATE_PROVIDER
            ? 'Rotate usage'
            : (providers.find((entry) => entry.id === status?.provider)?.label ?? status?.provider ?? '—')}
        </SettingRow>
        <SettingRow
          title="Model"
          hint="New sessions start on the model picked last. Each session keeps its own — changing it in one tab leaves the others alone."
        >
          <span className="font-mono text-[12.5px]">{status === null || status.model !== '' || status.provider === ROTATE_PROVIDER ? modelLabel(status) : 'not set'}</span>
        </SettingRow>
      </div>

      <h2 className="mb-3 text-[14px] text-text">Custom instructions</h2>
      <div className="mb-8">
        <InstructionsField
          value={preferences?.instructions ?? ''}
          placeholder={'Answer in Indonesian.\nPrefer small, reviewable commits.\nNever touch files under legacy/.'}
          onSave={(text) => window.anticode.setPreferences({ instructions: text }).then(setPreferences)}
        />
      </div>

      <div className="glass-surface mb-8 overflow-hidden rounded-xl border border-line">
        <SettingRow
          title="Menu bar icon"
          hint="Quick capture (⌘⌥Space), recent sessions, and Show anticode from the menu bar. With it on, closing the window keeps anticode running there."
        >
          <Toggle on={preferences?.tray === true} onChange={(value) => change({ tray: value })} />
        </SettingRow>
      </div>

      <h2 className="mb-1 text-[14px] text-text">Notifications</h2>
      <p className="mb-3 text-[12.5px] leading-relaxed text-faint">
        System notifications for what happens while you look elsewhere. Clicking one opens the session it is about.
      </p>
      <div className="glass-surface mb-8 overflow-hidden rounded-xl border border-line">
        <SettingRow title="Notifications" hint="Off mutes every kind below at once">
          <Toggle
            on={preferences?.notifications.enabled === true}
            onChange={(value) => change({ notifications: { ...preferences!.notifications, enabled: value } })}
          />
        </SettingRow>
        {(
          [
            ['complete', 'A run finishes', 'With the session name and how long it took'],
            ['error', 'A run fails', 'With the error it stopped on'],
            ['approval', 'A tool waits for approval', 'The session stays paused on it until you decide'],
            ['update', 'An update is available', 'From the source in Settings → Updates'],
            ['sound', 'Play a sound', 'The system notification sound'],
            ['background', 'Only when anticode is in the background', 'Off, they show even while you are looking at anticode']
          ] as const
        ).map(([key, title, hint]) => (
          // A wrapper would break the rows' dividers; each row is its own item.
          <SettingRow key={key} title={title} hint={hint}>
            <Toggle
              on={preferences?.notifications[key] === true}
              onChange={(value) => change({ notifications: { ...preferences!.notifications, [key]: value } })}
              label={title}
            />
          </SettingRow>
        ))}
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

/** The vendors' own APIs: a key is all they need, and they name themselves. */
const VENDOR_NAMES: Partial<Record<ProviderKind, string>> = { anthropic: 'Anthropic', 'openai-api': 'OpenAI' }

const KIND_OPTIONS: { value: ProviderKind; label: string }[] = [
  { value: 'openai', label: 'OpenAI-compatible' },
  { value: 'ollama', label: 'Local server' },
  { value: 'anthropic', label: 'Anthropic API' },
  { value: 'openai-api', label: 'OpenAI API' }
]

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
  const vendor = VENDOR_NAMES[values.kind] !== undefined
  // A vendor API names itself and knows its own address; a gateway does not.
  const valid =
    editing ||
    ((vendor || values.label.trim() !== '') &&
      (vendor || values.baseURL.trim() !== '') &&
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
          placeholder={VENDOR_NAMES[values.kind] ?? 'OpenRouter, LM Studio, …'}
          className={inputClass}
        />
      </label>
      {!editing ? (
        <label className="col-span-2">
          <span className="mb-1 block text-[12px] text-faint">Type</span>
          <div className="flex rounded-lg border border-line p-0.5">
            {KIND_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                data-provider-kind={option.value}
                onClick={() =>
                  set({
                    kind: option.value,
                    // A name the form filled in follows the type; a typed one stays.
                    ...(values.label === '' || Object.values(VENDOR_NAMES).includes(values.label)
                      ? { label: VENDOR_NAMES[option.value] ?? '' }
                      : {})
                  })
                }
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
        <span className="mb-1 block text-[12px] text-faint">Base URL{vendor ? ' (optional)' : ''}</span>
        <input
          value={values.baseURL}
          onChange={(event) => set({ baseURL: event.target.value })}
          placeholder={
            VENDOR_BASE_URLS[values.kind] ??
            (values.kind === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://api.example.com/v1')
          }
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
            placeholder={hasKey ? 'Saved — leave empty to keep it' : values.kind === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
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
    if (added !== undefined && added.credentialAvailable && status?.rotationEnabled !== true) onSelectProvider(added.id, '')
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
          const active = provider.id === status?.defaultProvider
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
                    {kind === 'anthropic' && <Tag>Anthropic API</Tag>}
                    {kind === 'openai-api' && <Tag>OpenAI API</Tag>}
                    {active && <span className="text-[11.5px] text-brand">default</span>}
                    {!provider.credentialAvailable && <Tag>needs key</Tag>}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11.5px] text-faint">
                    {details.join(' · ')}
                  </div>
                </div>
                {!active && provider.credentialAvailable && !removingThis && (
                  <button
                    type="button"
                    title={`Use ${provider.label} as the default provider`}
                    onClick={() => onSelectProvider(provider.id, '')}
                    className="shrink-0 rounded-md px-2 py-1 text-[12px] text-faint transition-colors hover:bg-raised hover:text-brand"
                  >
                    Default
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

      <RotateUsage status={status} providers={providers} />
    </>
  )
}

/**
 * The Rotate usage pool: models that share the token load of every session
 * set to Rotate. A session stays on one for 2 prompts, then moves to the one
 * that has used the fewest tokens; one that fails hands the turn to the next
 * and rests for a minute. It runs only while switched on here — off, Rotate
 * is not offered and nothing is counted. Changes reach every window through
 * the status broadcast.
 *
 * Groups name parts of the pool for one kind of work. The tabs pick which one
 * is shown here; the one in use — marked lime — is what every session rotates
 * over, and putting another in use moves every composer with it.
 */
function RotateUsage({
  status,
  providers
}: {
  status: SessionStatus | null
  providers: ProviderInfo[]
}): JSX.Element {
  const pool = status?.rotation ?? []
  const groups = status?.rotationGroups ?? []
  const inUseId = status?.rotationGroup ?? null
  const usable = providers.filter((entry) => entry.credentialAvailable)
  const [viewing, setViewing] = useState<string | null>(inUseId)
  const [adding, setAdding] = useState<Adding | null>(null)
  const [catalogue, setCatalogue] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const enabled = status?.rotationEnabled === true
  const now = Date.now()

  // A group removed elsewhere (the phone, another window) takes its tab with it.
  const viewed = groups.find((group) => group.id === viewing) ?? null
  const shown: RotationEntryStatus[] =
    viewed === null
      ? pool
      : viewed.entries.flatMap((entry) => pool.filter((item) => sameEntry(item, entry)))
  const inUse = inUseId === (viewed?.id ?? null)

  // The name field follows the tab, and whatever the main process settled on.
  const [name, setName] = useState(viewed?.name ?? '')
  useEffect(() => {
    setName(viewed?.name ?? '')
  }, [viewed?.id, viewed?.name])

  // The ids offered for the provider being added: what it lists, then what
  // its endpoint reports. Typing any other id works too.
  useEffect(() => {
    if (adding === null) return
    let active = true
    setCatalogue([])
    void window.anticode.listModels(adding.provider).then((result) => {
      if (active) setCatalogue(result.models)
    })
    return () => {
      active = false
    }
  }, [adding?.provider])

  function settle(work: Promise<unknown>): Promise<boolean> {
    return work
      .then(() => {
        setError(null)
        return true
      })
      .catch((failure) => {
        setError((failure as Error).message)
        return false
      })
  }

  function savePool(next: RotationEntry[]): Promise<boolean> {
    return settle(window.anticode.setRotation(next.map(plainEntry)))
  }

  function saveGroups(next: RotationGroupInput[]): Promise<boolean> {
    return settle(window.anticode.setRotationGroups(next))
  }

  function plainGroups(): RotationGroupInput[] {
    return groups.map((group) => ({ id: group.id, name: group.name, entries: group.entries.map(plainEntry) }))
  }

  /** Every group as it is, one of them rewritten — or, for null, removed. */
  function groupsWith(id: string, change: (group: RotationGroupInput) => RotationGroupInput | null): RotationGroupInput[] {
    return plainGroups().flatMap((group) => {
      if (group.id !== id) return [group]
      const changed = change(group)
      return changed === null ? [] : [changed]
    })
  }

  function setEnabled(on: boolean): void {
    if (!on) setAdding(null)
    void settle(window.anticode.setRotationEnabled(on))
  }

  function view(id: string | null): void {
    setViewing(id)
    setAdding(null)
    setNaming(false)
    setError(null)
  }

  function useGroup(id: string | null): void {
    void settle(window.anticode.selectRotationGroup(id))
  }

  function newGroup(): void {
    const taken = new Set(groups.map((group) => group.name.toLowerCase()))
    let count = groups.length + 1
    while (taken.has(`group ${count}`)) count += 1
    const before = new Set(groups.map((group) => group.id))
    void window.anticode
      .setRotationGroups([...plainGroups(), { name: `Group ${count}`, entries: [] }])
      .then((next) => {
        setError(null)
        const made = next.rotationGroups.find((group) => !before.has(group.id))
        if (made === undefined) return
        view(made.id)
        setNaming(true)
      })
      .catch((failure) => setError((failure as Error).message))
  }

  function rename(): void {
    setNaming(false)
    if (viewed === null) return
    const next = name.trim()
    if (next === '' || next === viewed.name) {
      setName(viewed.name)
      return
    }
    void saveGroups(groupsWith(viewed.id, (group) => ({ ...group, name: next }))).then((saved) => {
      if (!saved) setName(viewed.name)
    })
  }

  function deleteGroup(): void {
    if (viewed === null) return
    void saveGroups(groupsWith(viewed.id, () => null)).then((saved) => {
      if (saved) view(null)
    })
  }

  function remove(entry: RotationEntry): void {
    if (viewed === null) {
      void savePool(pool.filter((item) => !sameEntry(item, entry)))
      return
    }
    void saveGroups(
      groupsWith(viewed.id, (group) => ({ ...group, entries: group.entries.filter((item) => !sameEntry(item, entry)) }))
    )
  }

  function startAdding(replacing?: RotationEntryStatus): void {
    const first = usable[0]
    if (replacing !== undefined) {
      setAdding({ provider: replacing.provider, model: '', replacing: plainEntry(replacing) })
      return
    }
    if (first === undefined) {
      setError('Add a provider with a key first.')
      return
    }
    setAdding({ provider: first.id, model: viewed === null ? first.defaultModel : '' })
  }

  async function add(): Promise<void> {
    if (adding === null || adding.model.trim() === '') return
    const entry = { provider: adding.provider, model: adding.model.trim() }
    const replacing = adding.replacing
    if (shown.some((item) => sameEntry(item, entry))) {
      setError(viewed === null ? 'That model is already in the pool.' : 'That model is already in this group.')
      return
    }
    /** The list with the spent model swapped for its replacement in place, or the new one added. */
    const swapped = (list: RotationEntry[]): RotationEntry[] =>
      replacing === undefined
        ? [...list, entry]
        : list.map((item) => (sameEntry(item, replacing) ? entry : plainEntry(item)))
    let saved: boolean
    if (viewed !== null) {
      saved = await saveGroups(groupsWith(viewed.id, (group) => ({ ...group, entries: swapped(group.entries) })))
    } else if (replacing !== undefined) {
      // Replaced in the whole pool, it is replaced in every group it was in
      // too — the groups first, so the pool can then let the spent one go.
      saved =
        (await saveGroups(plainGroups().map((group) => ({ ...group, entries: swapped(group.entries) })))) &&
        (await savePool(swapped(pool)))
    } else {
      saved = await savePool(swapped(pool))
    }
    if (saved) setAdding(null)
  }

  // In a group, the pool's own models for the chosen provider come first:
  // most of the time a group is filled from models already switched on.
  const suggestions = [
    ...new Set([
      ...(viewed !== null ? pool.filter((entry) => entry.provider === adding?.provider).map((entry) => entry.model) : []),
      ...(providers.find((entry) => entry.id === adding?.provider)?.models ?? []),
      ...catalogue
    ])
  ]

  const tabClass = (selected: boolean): string =>
    `flex items-center rounded-lg border px-3 py-1.5 text-[12.5px] transition-colors ${
      selected ? 'glass-control text-text' : 'border-transparent text-dim hover:bg-raised hover:text-brand'
    }`

  return (
    <>
      <div className={`mt-10 flex items-center justify-between gap-4 ${enabled ? 'mb-4' : ''}`}>
        <h2 className="text-[14px] text-text">Rotate usage</h2>
        <div className="flex items-center gap-3">
          {enabled && pool.length > 0 && (
            <span className="text-[11.5px] text-brand">active for every session</span>
          )}
          <Toggle on={enabled} onChange={setEnabled} label="Rotate usage" />
        </div>
      </div>

      {!enabled && error !== null && <p className="mt-2 text-[12px] text-del">{error}</p>}

      {enabled && (
        <>
          {/* One tab per group, the whole pool first. The lime dot marks the
              one in use and keeps its room on the others, so putting another
              group in use never nudges a tab sideways. */}
          <div className="mb-3 flex flex-wrap items-center gap-1" data-rotation-groups>
            {[{ id: null, name: 'All models', count: pool.length }, ...groups.map((group) => ({
              id: group.id as string | null,
              name: group.name,
              count: group.entries.length
            }))].map((tab) => (
              <button
                key={tab.id ?? ''}
                type="button"
                data-rotation-group={tab.name}
                title={tab.id === inUseId ? `${tab.name} — in use` : tab.name}
                onClick={() => view(tab.id)}
                className={tabClass(tab.id === (viewed?.id ?? null))}
              >
                <span
                  aria-hidden
                  className={`mr-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand ${tab.id === inUseId ? '' : 'invisible'}`}
                />
                <span className="max-w-40 truncate">{tab.name}</span>
                <span className={`ml-1.5 inline-block min-w-[1ch] tabular-nums text-faint ${tab.count > 0 ? '' : 'invisible'}`}>
                  {tab.count}
                </span>
              </button>
            ))}
            <button
              type="button"
              data-rotation-new-group
              onClick={newGroup}
              className="rounded-lg border border-transparent px-3 py-1.5 text-[12.5px] text-faint transition-colors hover:bg-raised hover:text-brand"
            >
              + New group
            </button>
          </div>

          <div className="glass-surface overflow-hidden rounded-xl border border-line">
            <div className="flex items-center gap-3 border-b border-line-soft px-5 py-2.5">
              {viewed === null ? (
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-faint">
                  Every model switched on in Settings → Models
                </span>
              ) : (
                <input
                  value={name}
                  autoFocus={naming}
                  onFocus={(event) => {
                    if (naming) event.target.select()
                  }}
                  aria-label="Group name"
                  maxLength={40}
                  spellCheck={false}
                  onChange={(event) => setName(event.target.value)}
                  onBlur={rename}
                  onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') {
                      setName(viewed.name)
                      setNaming(false)
                      event.currentTarget.blur()
                    }
                  }}
                  className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 -ml-2 text-[13.5px] text-text outline-none transition-colors hover:border-line focus:border-hover"
                />
              )}
              {inUse ? (
                <span className="shrink-0 px-2 py-1 text-[12px] text-brand">in use</span>
              ) : (
                <button
                  type="button"
                  data-rotation-use
                  title="Every session rotates over these from its next prompt"
                  onClick={() => useGroup(viewed?.id ?? null)}
                  className="shrink-0 rounded-md px-2 py-1 text-[12px] text-dim transition-colors hover:bg-raised hover:text-brand"
                >
                  {viewed === null ? 'Use all models' : 'Use this group'}
                </button>
              )}
              {viewed !== null && (
                <button
                  type="button"
                  title={`Delete the ${viewed.name} group — its models stay in the pool`}
                  onClick={deleteGroup}
                  className="shrink-0 rounded-md px-2 py-1 text-[12px] text-faint transition-colors hover:bg-raised hover:text-del"
                >
                  Delete group
                </button>
              )}
            </div>

            {shown.map((entry) => {
              const resting = entry.coolingUntil !== null && entry.coolingUntil > now
              const spent = entry.outOfUsage
              const replacingThis = adding?.replacing !== undefined && sameEntry(adding.replacing, entry)
              return (
                <div
                  key={`${entry.provider}\n${entry.model}`}
                  className="flex items-center gap-3 border-b border-line-soft px-5 py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`truncate font-mono text-[12.5px] ${entry.ready && spent === null ? 'text-text' : 'text-dim'}`}
                      >
                        {entry.model}
                      </span>
                      {!entry.ready && <Tag>needs key</Tag>}
                      {spent !== null && (
                        <span
                          data-out-of-usage={entry.model}
                          className="shrink-0 rounded border border-del/40 px-1.5 py-0.5 text-[10.5px] text-del"
                        >
                          out of usage
                        </span>
                      )}
                      {resting && spent === null && <Tag>resting</Tag>}
                    </div>
                    <div
                      className="mt-0.5 truncate text-[11.5px] text-faint"
                      title={spent !== null ? spent.reason : undefined}
                    >
                      {entry.label} ·{' '}
                      {spent !== null
                        ? `ran out ${sinceLabel(spent.since)} — replace it, or it is tried only when nothing else is left`
                        : `${compactTokens(entry.inputTokens)} in · ${compactTokens(entry.outputTokens)} out`}
                    </div>
                  </div>
                  {spent !== null && (
                    <button
                      type="button"
                      data-rotation-replace={entry.model}
                      title={`Swap ${entry.model} for another model`}
                      onClick={() => startAdding(entry)}
                      className={`shrink-0 rounded-md px-2 py-0.5 text-[12px] transition-colors hover:bg-raised hover:text-brand ${
                        replacingThis ? 'text-text' : 'text-dim'
                      }`}
                    >
                      Replace
                    </button>
                  )}
                  <button
                    type="button"
                    title={viewed === null ? `Take ${entry.model} out of the rotation` : `Take ${entry.model} out of ${viewed.name}`}
                    aria-label={viewed === null ? `Take ${entry.model} out of the rotation` : `Take ${entry.model} out of ${viewed.name}`}
                    onClick={() => remove(entry)}
                    className="shrink-0 rounded-md px-2 py-0.5 text-[15px] leading-none text-faint transition-colors hover:bg-raised hover:text-brand"
                  >
                    ×
                  </button>
                </div>
              )
            })}
            {shown.length === 0 && adding === null && (
              <div className="px-5 py-4 text-[12.5px] text-faint">
                {viewed === null
                  ? 'No models yet. Add two or more to rotate between them.'
                  : 'No models in this group yet. Add the ones that suit its work.'}
              </div>
            )}
            {adding !== null && (
              <div
                className="flex items-center gap-2 border-t border-line-soft px-5 py-3"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setAdding(null)
                  if (event.key === 'Enter') void add()
                }}
              >
                <select
                  value={adding.provider}
                  aria-label="Provider"
                  onChange={(event) => {
                    const next = usable.find((entry) => entry.id === event.target.value)
                    setAdding({ ...adding, provider: event.target.value, model: viewed === null && adding.replacing === undefined ? (next?.defaultModel ?? '') : '' })
                  }}
                  className="glass-field w-40 shrink-0 rounded-lg border border-line px-2 py-1.5 text-[12.5px] text-text outline-none"
                >
                  {usable.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
                <input
                  value={adding.model}
                  autoFocus
                  list="rotation-models"
                  spellCheck={false}
                  placeholder={adding.replacing !== undefined ? `Replace ${adding.replacing.model} with…` : 'Model id'}
                  onChange={(event) => setAdding({ ...adding, model: event.target.value })}
                  className="glass-field min-w-0 flex-1 rounded-lg border border-line px-3 py-1.5 font-mono text-[12.5px] text-text outline-none placeholder:text-faint focus:border-hover"
                />
                <datalist id="rotation-models">
                  {suggestions.map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
                <button
                  type="button"
                  onClick={() => setAdding(null)}
                  className="shrink-0 rounded-lg px-2 py-1.5 text-[12.5px] text-dim transition-colors hover:bg-raised hover:text-brand"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void add()}
                  disabled={adding.model.trim() === ''}
                  className="glass-control shrink-0 rounded-lg border px-3 py-1.5 text-[12.5px] text-text transition-colors hover:text-brand disabled:cursor-not-allowed disabled:text-faint"
                >
                  {adding.replacing !== undefined ? 'Replace' : 'Add'}
                </button>
              </div>
            )}
          </div>

          {error !== null && <p className="mt-2 text-[12px] text-del">{error}</p>}

          <div className="mt-3 flex items-center gap-4">
            {adding === null && (
              <button
                type="button"
                data-rotation-add
                onClick={() => startAdding()}
                className="text-[12px] text-faint transition-colors hover:text-brand"
              >
                + Add model
              </button>
            )}
            {pool.length > 0 && (
              <button
                type="button"
                title="Start every model's token count from zero, and give models that ran out another chance"
                onClick={() => void settle(window.anticode.resetRotationUsage())}
                className="text-[12px] text-faint transition-colors hover:text-brand"
              >
                Reset counts
              </button>
            )}
          </div>
        </>
      )}
    </>
  )
}

/** The model being added — in place of a spent one, when `replacing` is set. */
interface Adding extends RotationEntry {
  replacing?: RotationEntry
}

function sameEntry(a: RotationEntry, b: RotationEntry): boolean {
  return a.provider === b.provider && a.model === b.model
}

/** Just the provider and model, as the main process takes them. */
function plainEntry({ provider, model }: RotationEntry): RotationEntry {
  return { provider, model }
}

/** "at 14:02" today, "on 11 Sep" before. */
function sinceLabel(since: number): string {
  const at = new Date(since)
  return at.toDateString() === new Date().toDateString()
    ? `at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : `on ${at.toLocaleDateString([], { day: 'numeric', month: 'short' })}`
}

/**
 * The models the composer offers. A provider's catalogue can run to hundreds;
 * the ones switched on here are all its picker shows, and they are also the
 * pool a session set to Rotate spreads its prompts over while Rotate usage is
 * on. Switching none on leaves the picker empty.
 */
function Models({
  status,
  providers,
  onSelectProvider
}: {
  status: SessionStatus | null
  providers: ProviderInfo[]
  onSelectProvider: (provider: ProviderId, model: string) => void
}): JSX.Element {
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null)
  const [query, setQuery] = useState('')
  const [pickedOnly, setPickedOnly] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const usable = providers.filter((entry) => entry.credentialAvailable)
  // Rotation has no catalogue of its own; its models come from a provider's.
  const [provider, setProvider] = useState<ProviderId>(() =>
    status?.provider !== undefined && status.provider !== ROTATE_PROVIDER
      ? status.provider
      : (usable[0]?.id ?? 'clinepass')
  )
  const pool = status?.rotation ?? []
  const enabled = status?.rotationEnabled === true
  const picked = pool.filter((entry) => entry.provider === provider).map((entry) => entry.model)

  useEffect(() => {
    let active = true
    setCatalogue(null)
    void window.anticode.listModels(provider).then((result) => {
      if (active) setCatalogue(result)
    })
    return () => {
      active = false
    }
  }, [provider])

  function setPicked(model: string, on: boolean): void {
    const rest = pool
      .filter((entry) => !(entry.provider === provider && entry.model === model))
      .map(({ provider: id, model: name }) => ({ provider: id, model: name }))
    void window.anticode
      .setRotation(on ? [...rest, { provider, model }] : rest)
      .then(() => setError(null))
      .catch((failure) => setError((failure as Error).message))
  }

  const needle = query.trim().toLowerCase()
  // Ids typed by hand (a subscription model no catalogue lists) stay visible
  // once picked, ahead of the catalogue.
  const listed = [
    ...picked.filter((id) => !(catalogue?.models ?? []).includes(id)),
    ...(catalogue?.models ?? [])
  ]
  const matches = listed.filter(
    (id) => (!pickedOnly || picked.includes(id)) && (needle === '' || id.toLowerCase().includes(needle))
  )
  const typed = query.trim()
  const canAddTyped = typed !== '' && !listed.includes(typed)

  return (
    <>
      <h1 className="mb-2 text-[19px] text-text">Models</h1>
      <p className="mb-6 text-[12.5px] leading-relaxed text-faint">
        Switch on the models the composer should offer — its picker shows only these. With Rotate
        usage on, sessions set to <span className="text-dim">Rotate</span> spread their prompts over the
        same models.
      </p>

      {providers.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {providers.map((entry) => {
            const count = pool.filter((item) => item.provider === entry.id).length
            return (
              <button
                key={entry.id}
                type="button"
                disabled={!entry.credentialAvailable}
                title={entry.credentialAvailable ? entry.label : `Needs ${entry.credentialHint}`}
                onClick={() => setProvider(entry.id)}
                className={`rounded-lg border px-3 py-1.5 text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:text-faint ${
                  entry.id === provider ? 'glass-control text-text' : 'border-transparent text-dim hover:bg-raised hover:text-brand'
                }`}
              >
                {entry.label}
                {/* The count keeps its room at zero, so switching a model on
                    never pushes the tabs after it sideways. */}
                <span className={`ml-1.5 inline-block min-w-[1ch] tabular-nums text-faint ${count > 0 ? '' : 'invisible'}`}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      )}

      <div className="mb-4 flex items-center gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canAddTyped) {
              setPicked(typed, true)
              setQuery('')
            }
          }}
          placeholder="Search models, or type an id and press Enter to add it"
          className="glass-field min-w-0 flex-1 rounded-lg border border-line px-4 py-2.5 text-[13.5px] text-text outline-none placeholder:text-faint focus:border-hover"
        />
        <div className="flex shrink-0 rounded-lg border border-line p-0.5">
          {([false, true] as const).map((only) => (
            <button
              key={String(only)}
              type="button"
              onClick={() => setPickedOnly(only)}
              className={`rounded-md px-3 py-1.5 text-[12.5px] tabular-nums transition-colors ${
                pickedOnly === only ? 'glass-control text-text' : 'text-dim hover:text-brand'
              }`}
            >
              {only ? `Picked · ${picked.length}` : 'All'}
            </button>
          ))}
        </div>
      </div>

      {error !== null && <p className="mb-3 text-[12px] text-del">{error}</p>}

      <div className="glass-surface overflow-hidden rounded-xl border border-line">
        {canAddTyped && (
          <button
            type="button"
            onClick={() => {
              setPicked(typed, true)
              setQuery('')
            }}
            className="flex w-full items-center gap-3 border-b border-line-soft px-5 py-3 text-left font-mono text-[12.5px] text-dim transition-colors hover:bg-raised hover:text-brand"
          >
            + Add {typed}
          </button>
        )}
        {matches.map((id) => {
          const on = picked.includes(id)
          const isDefault = id === status?.defaultModel && status.defaultProvider === provider
          return (
            <div
              key={id}
              className="group flex items-center gap-2 border-b border-line-soft pr-5 transition-colors last:border-b-0 hover:bg-raised"
            >
              {/* The name switches the model too; the switch is the same one
                  Auto-accept and Rotate usage wear. */}
              <button
                type="button"
                data-model-name={id}
                title={on ? 'Hide from the composer' : 'Show in the composer'}
                onClick={() => setPicked(id, !on)}
                className={`min-w-0 flex-1 truncate py-3 pl-5 text-left font-mono text-[13px] transition-colors hover:text-brand ${
                  on ? 'text-text' : 'text-dim'
                }`}
              >
                {id}
              </button>
              {isDefault ? (
                <span className="shrink-0 px-2 text-[11.5px] text-faint">default</span>
              ) : !enabled ? (
                <button
                  type="button"
                  title="Start new sessions on this model"
                  onClick={() => onSelectProvider(provider, id)}
                  className="shrink-0 rounded-md px-2 py-1 text-[12px] text-faint opacity-0 transition-colors hover:bg-raised hover:text-brand focus-visible:opacity-100 group-hover:opacity-100"
                >
                  Use
                </button>
              ) : null}
              <Toggle
                on={on}
                onChange={(value) => setPicked(id, value)}
                label={id}
                title={on ? 'Hide from the composer' : 'Show in the composer'}
                data-model-pick={id}
              />
            </div>
          )
        })}
        {matches.length === 0 && !canAddTyped && (
          <div className="px-5 py-4 text-[12.5px] text-faint">
            {catalogue === null
              ? 'Loading models…'
              : pickedOnly
                ? 'Nothing picked from this provider yet — the composer offers none of its models.'
                : catalogue.error !== null
                  ? `Could not load the model list: ${catalogue.error}. Type an id above and press Enter.`
                  : 'No models match.'}
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
      id: 'pricing',
      label: 'Pricing',
      icon: (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <circle cx="8" cy="8" r="6" />
          <path d="M9.9 5.8c-.3-.7-1-1.1-1.9-1.1-1.1 0-1.9.6-1.9 1.5 0 2 3.8 1.1 3.8 3.3 0 .9-.9 1.6-2 1.6-.9 0-1.7-.4-2-1.2M8 3.6v1.1M8 11.1v1.3" strokeLinecap="round" />
        </svg>
      )
    },
    {
      id: 'mcp',
      label: 'MCP',
      icon: (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0z" strokeLinejoin="round" />
          <path d="M8 11.5v2" strokeLinecap="round" />
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
    },
    {
      id: 'updates',
      label: 'Updates',
      icon: (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M8 2.5v7.5M4.8 7L8 10.2 11.2 7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2.5 11.5v1a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-1" strokeLinecap="round" />
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
                section === item.id
                  ? 'glass-control border text-text'
                  : 'border border-transparent text-dim hover:bg-raised hover:text-brand'
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

      {/* The scrollbar's room is kept whether or not a page needs it, so a
          short page and a long one line up to the pixel. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-10 pt-8 pb-10 [scrollbar-gutter:stable]">
        <div className="mx-auto max-w-2xl">
          {section === 'general' && (
            <General status={status} providers={providers} onToggleAutoApprove={onToggleAutoApprove} />
          )}
          {section === 'providers' && (
            <>
              <Providers
                providers={providers}
                status={status}
                onSelectProvider={onSelectProvider}
                onProvidersChange={onProvidersChange}
              />
              <div className="mt-8">
                <Credentials onChanged={() => void window.anticode.listProviders().then(onProvidersChange)} />
              </div>
            </>
          )}
          {section === 'models' && (
            <Models status={status} providers={providers} onSelectProvider={onSelectProvider} />
          )}
          {section === 'pricing' && <Pricing status={status} providers={providers} />}
          {section === 'mcp' && <Mcp />}
          {section === 'remote' && <Remote />}
          {section === 'updates' && <Updates />}
        </div>
      </div>
    </div>
  )
}
