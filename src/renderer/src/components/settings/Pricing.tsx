import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { PricedModel, ProviderInfo, SessionStatus } from '@shared/ipc'
import { useSessionStore } from '../../store/session'
import { formatUsd } from '../../money'

const SOURCE_LABEL: Record<PricedModel['source'], string> = {
  custom: 'yours',
  gateway: 'gateway',
  'built-in': 'built-in',
  free: 'free tier',
  unknown: 'no price'
}

function errorText(failure: unknown): string {
  return (failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/**
 * One model's price, editable in place. Typing a price makes it the user's;
 * Reset hands the model back to the gateway's or the built-in price.
 */
function PriceRow({ row, label, spent, onSaved }: { row: PricedModel; label: string; spent: number | null; onSaved: () => void }): JSX.Element {
  const [input, setInput] = useState(row.price?.input.toString() ?? '')
  const [output, setOutput] = useState(row.price?.output.toString() ?? '')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setInput(row.price?.input.toString() ?? '')
    setOutput(row.price?.output.toString() ?? '')
  }, [row.price?.input, row.price?.output])
  const changed = input !== (row.price?.input.toString() ?? '') || output !== (row.price?.output.toString() ?? '')

  async function save(price: { input: number; output: number } | null): Promise<void> {
    setError(null)
    try {
      await window.anticode.setPrice(row.model, price)
      onSaved()
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  const field =
    'glass-field w-20 rounded-md border px-2 py-1 text-right font-mono text-[12px] tabular-nums text-text outline-none placeholder:text-faint'
  return (
    <div className="border-b border-line-soft px-5 py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12.5px] text-text">{row.model}</div>
          <div className="text-[11.5px] text-faint">
            {label} · <span className={row.source === 'unknown' ? 'text-del' : ''}>{SOURCE_LABEL[row.source]}</span>
            {spent !== null ? ` · spent ${formatUsd(spent)}` : ''}
          </div>
        </div>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          inputMode="decimal"
          placeholder="in"
          aria-label={`${row.model} input price`}
          className={field}
        />
        <input
          value={output}
          onChange={(event) => setOutput(event.target.value)}
          inputMode="decimal"
          placeholder="out"
          aria-label={`${row.model} output price`}
          className={field}
        />
        <button
          type="button"
          disabled={!changed || input.trim() === '' || output.trim() === ''}
          onClick={() => void save({ input: Number(input), output: Number(output) })}
          className="w-12 rounded-md border border-transparent px-2 py-1 text-[12px] text-dim transition-colors enabled:hover:text-brand disabled:text-faint/50"
        >
          Save
        </button>
        <button
          type="button"
          disabled={row.source !== 'custom'}
          onClick={() => void save(null)}
          title="Go back to the gateway's or the built-in price"
          className="w-12 rounded-md border border-transparent px-2 py-1 text-[12px] text-dim transition-colors enabled:hover:text-brand disabled:text-faint/50"
        >
          Reset
        </button>
      </div>
      {error !== null && <div className="mt-1 text-[11.5px] text-del">{error}</div>}
    </div>
  )
}

/**
 * Prices behind every cost estimate, for the models the composer offers and
 * any model that has been used. Dollars per million tokens.
 */
export function Pricing({ status, providers }: { status: SessionStatus | null; providers: ProviderInfo[] }): JSX.Element {
  const usage = useSessionStore((state) => state.usage)
  const [rows, setRows] = useState<PricedModel[]>([])
  // Usage is kept under the provider's display name; prices are looked up by id.
  const idOf = (provider: string): string =>
    providers.find((entry) => entry.id === provider || entry.label === provider)?.id ?? provider
  const models = [
    ...(status?.rotation ?? []).map(({ provider, model }) => ({ provider, model })),
    ...usage.map(({ provider, model }) => ({ provider: idOf(provider), model }))
  ]
  const signature = JSON.stringify(models)

  function load(): void {
    void window.anticode.listPrices(JSON.parse(signature) as { provider: string; model: string }[]).then(setRows)
  }
  useEffect(load, [signature])

  const labelOf = (provider: string): string => providers.find((entry) => entry.id === provider)?.label ?? provider
  const spentOn = (model: string): number | null => {
    const entries = usage.filter((entry) => entry.model === model)
    return entries.length === 0 ? null : entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)
  }
  const total = usage.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)
  const unpriced = rows.filter((row) => row.source === 'unknown').length

  return (
    <>
      <h1 className="mb-2 text-[19px] text-text">Pricing</h1>
      <p className="mb-6 text-[12.5px] leading-relaxed text-faint">
        Dollars per million tokens, behind every cost estimate in the run footer and the usage popover. A price you
        type wins; then the one a gateway publishes with its model list; then the built-in Anthropic rates. Models
        with no price are left out of estimates rather than guessed. Estimates count input and output tokens only —
        cache discounts and provider surcharges are not included.
      </p>

      <div className="glass-surface mb-6 flex items-baseline justify-between rounded-xl border border-line px-5 py-4">
        <div>
          <div className="text-[13.5px] text-text">Estimated spend on this computer</div>
          <div className="mt-0.5 text-[12px] text-faint">
            {unpriced > 0 ? `${unpriced} ${unpriced === 1 ? 'model has' : 'models have'} no price and count as $0` : 'Every model below has a price'}
          </div>
        </div>
        <div className="text-[19px] tabular-nums text-text">{formatUsd(total)}</div>
      </div>

      <div className="glass-surface mb-3 overflow-hidden rounded-xl border border-line">
        <div className="flex items-center gap-3 border-b border-line-soft px-5 py-2 text-[11px] text-faint">
          <span className="flex-1">Model</span>
          <span className="w-20 text-right">Input</span>
          <span className="w-20 text-right">Output</span>
          <span className="w-12" />
          <span className="w-12" />
        </div>
        {rows.length === 0 ? (
          <div className="px-5 py-4 text-[12.5px] text-faint">Pick models in Settings → Models, or send a prompt, and they show here.</div>
        ) : (
          rows.map((row) => (
            <PriceRow key={`${row.provider}:${row.model}`} row={row} label={labelOf(row.provider)} spent={spentOn(row.model)} onSaved={load} />
          ))
        )}
      </div>
    </>
  )
}
