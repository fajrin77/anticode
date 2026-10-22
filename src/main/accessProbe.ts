import type { AccessProbeResult } from '@shared/ipc'
import { observeAccessFailure, observeAccessSuccess } from './accessLedger'
import { createProvider, listProviders } from './providers'
import { clinepassConfig } from './providers/clinepass'
import { listCustomProviders } from './providers/custom'
import { failureStatus } from './providers/failures'
import { providerKeyId } from './providers/keyring'
import { rotationEntries } from './rotation'
import { loadPersistedSettings, savePersistedSettings } from './settings'

/*
 * "Test all" in Settings → Usage: one tiny request per account and per API
 * key, through the same provider code a session uses, so the access report
 * stops saying "not tested yet". Each result lands in the access ledger like
 * a real turn would. Keys and tokens never leave this module.
 */

const TIMEOUT_MS = 45_000
const PARALLEL = 4

interface Probe { id: string; label: string; group: string; provider: string; model: string; keys?: string[] }

/** The model a session would most likely use: a rotation pick first, then the list. */
function modelFor(provider: string, listed: string[] | undefined): string | undefined {
  return rotationEntries().find(entry => entry.provider === provider)?.model ?? listed?.[0]
}

function scrub(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join('[key]')
  return out.replace(/\b(sk|pk|rk)-[\w-]{8,}/g, '[key]').replace(/Bearer\s+\S+/gi, 'Bearer [key]').replace(/\s+/g, ' ').trim().slice(0, 240)
}

function probes(): Probe[] {
  const providers = listProviders()
  const list: Probe[] = []
  for (const info of providers) {
    if (!info.authKind) continue
    const model = modelFor(info.id, info.models)
    if (model) list.push({ id: info.id, label: info.label, group: info.authKind ?? 'auth', provider: info.id, model })
  }
  const keyed = (provider: string, label: string, listed: string[] | undefined, keys: string[]): void => {
    const unique = [...new Set(keys.filter(Boolean))]
    const model = modelFor(provider, listed)
    if (!model) return
    unique.forEach((key, index) => list.push({ id: providerKeyId(provider, key), label: `${label} · Key ${index + 1}`, group: provider, provider, model, keys: [key] }))
  }
  for (const config of listCustomProviders()) {
    keyed(config.id, config.label, providers.find(info => info.id === config.id)?.models ?? config.models, [config.apiKey, ...(config.apiKeys ?? [])])
  }
  const clinepass = clinepassConfig()
  if (!clinepass.removed && clinepass.baseURL !== null) keyed('clinepass', 'Clinepass', providers.find(info => info.id === 'clinepass')?.models, clinepass.apiKeys)
  return list
}

/** A test is a fresh look, so a key's earlier cooldown must not stand in for the answer. */
function clearKeyCooldown(id: string): void {
  const cooldowns = loadPersistedSettings().providerKeyCooldowns ?? {}
  const kept = Object.fromEntries(Object.entries(cooldowns).filter(([scope]) => scope !== id && !scope.startsWith(`${id}:`)))
  if (Object.keys(kept).length !== Object.keys(cooldowns).length) savePersistedSettings({ providerKeyCooldowns: kept })
}

async function run(probe: Probe): Promise<AccessProbeResult> {
  if (probe.keys) clearKeyCooldown(probe.id)
  const started = Date.now()
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  const base = { id: probe.id, label: probe.label, group: probe.group, model: probe.model }
  try {
    const provider = createProvider(probe.provider, probe.model, probe.keys)
    let answered = false
    for await (const event of provider.chat({
      sessionId: 'anticode-access-test',
      system: 'Reply with the single word OK.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'OK?' }] }],
      tools: [],
      // Reasoning models spend their budget thinking first; 64 left them mute.
      maxTokens: 1024,
      signal
    })) {
      if (event.type === 'response' || (event.type === 'text_delta' && event.text.length > 0)) answered = true
    }
    // Keyed providers write the ledger themselves; accounts need it here.
    if ((probe.provider.startsWith('auth:') || probe.provider === 'clinepass')) observeAccessSuccess(probe.id, probe.model)
    return { ...base, ok: answered, ms: Date.now() - started, ...(answered ? {} : { message: 'Tidak ada balasan.' }) }
  } catch (error) {
    if ((probe.provider.startsWith('auth:') || probe.provider === 'clinepass') && !signal.aborted) observeAccessFailure(probe.id, probe.model, error)
    const message = signal.aborted ? `Tidak menjawab dalam ${TIMEOUT_MS / 1000} detik.` : scrub(error instanceof Error ? error.message : String(error), probe.keys ?? [])
    const status = failureStatus(error)
    return { ...base, ok: false, ms: Date.now() - started, message, ...(status !== undefined ? { status } : {}) }
  }
}

let running: Promise<AccessProbeResult[]> | null = null

/** One run at a time; a second click joins the run already going. */
export function testAllAccess(): Promise<AccessProbeResult[]> {
  running ??= (async () => {
    const queue = probes()
    const results: AccessProbeResult[] = []
    const worker = async (): Promise<void> => {
      for (let probe = queue.shift(); probe; probe = queue.shift()) results.push(await run(probe))
    }
    await Promise.all(Array.from({ length: PARALLEL }, worker))
    return results
  })().finally(() => { running = null })
  return running
}
