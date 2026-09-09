import type { JSX } from 'react'
import type { AppInfo, ProviderId, ProviderInfo, SessionStatus } from '@shared/ipc'

interface SettingsViewProps {
  appInfo: AppInfo | null
  status: SessionStatus | null
  providers: ProviderInfo[]
  onSelectProvider: (provider: ProviderId, model: string) => void
  onBack: () => void
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex justify-between gap-6 border-b border-line-soft py-2.5 text-[13px]">
      <span className="text-dim">{label}</span>
      <span className="truncate font-mono text-text">{value}</span>
    </div>
  )
}

export function SettingsView({
  appInfo,
  status,
  providers,
  onSelectProvider,
  onBack
}: SettingsViewProps): JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-10 pt-6 pb-10">
      <div className="mx-auto max-w-2xl">
        <button
          type="button"
          onClick={onBack}
          className="mb-6 text-[13px] text-dim transition-colors hover:text-text"
        >
          ← Kembali
        </button>

        <h1 className="mb-8 text-[19px] text-text">Settings</h1>

        <section className="mb-10">
          <h2 className="mb-3 text-[14px] text-text">Model</h2>
          <div className="overflow-hidden rounded-lg border border-line">
            {providers.map((provider) => {
              const active = provider.id === status?.provider
              return (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => onSelectProvider(provider.id, provider.defaultModel)}
                  className={`flex w-full items-center justify-between border-b border-line-soft px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-raised ${
                    active ? 'bg-raised' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className={`text-[13.5px] ${active ? 'text-text' : 'text-dim'}`}>
                      {provider.label}
                    </div>
                    <div className="truncate font-mono text-[11.5px] text-faint">
                      {provider.defaultModel === '' ? 'model belum diisi' : provider.defaultModel}
                    </div>
                  </div>
                  <span className="shrink-0 text-[11.5px] text-faint">
                    {provider.credentialAvailable ? (active ? 'aktif' : 'siap') : provider.credentialHint}
                  </span>
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-faint">
            Kredensial dibaca dari berkas <span className="font-mono">.env</span> saat app dijalankan.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-[14px] text-text">Runtime</h2>
          <div>
            {appInfo && (
              <>
                <Row label="versi" value={appInfo.version} />
                <Row label="electron" value={appInfo.electron} />
                <Row label="node" value={appInfo.node} />
                <Row label="platform" value={appInfo.platform} />
              </>
            )}
            <Row label="workspace" value={status?.workspaceRoot ?? 'belum dipilih'} />
          </div>
        </section>
      </div>
    </div>
  )
}
