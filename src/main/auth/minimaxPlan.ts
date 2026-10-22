import { shell } from 'electron'
import { APP_VERSION } from '../version'
import type { AuthLoginCallbacks, AuthTokens } from './types'
/** M Plan (and Token Plan kept after the M Plan launch) serves M3.1 Flash; older plans still report M3/M2.x. */
export const MINIMAX_PLAN_MODELS = ['MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5'] as const

/** Token Plan keys are separate from wallet/PAYG keys. Never substitute one for the other. */
export async function loginMiniMaxPlan(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const url = 'https://platform.minimax.io/console/plan'
  callbacks.onUpdate({ message: 'Login ke MiniMax → Plan Details, salin Subscription Key (sk-cp) M Plan / Token Plan, lalu tempel di Anticode. Membuka dashboard saja belum menghubungkan akun.', url })
  void shell.openExternal(url)
  const key = (await callbacks.promptForCode('Paste your MiniMax Subscription Key (sk-cp) from Plan Details')).trim()
  callbacks.signal.throwIfAborted()
  if (!/^sk-cp-\S+$/.test(key)) throw new Error('Use a MiniMax Token Plan sk-cp key, not a wallet/PAYG API key.')
  const response = await fetch('https://www.minimax.io/v1/token_plan/remains', { headers: { authorization: `Bearer ${key}`, 'user-agent': `anticode/${APP_VERSION}`, accept: 'application/json' }, signal: AbortSignal.any([callbacks.signal, AbortSignal.timeout(15_000)]) })
  if (!response.ok) throw new Error(`MiniMax Token Plan validation failed (HTTP ${response.status}). Check the plan key and subscription.`)
  const data = await response.json() as { base_resp?: { status_code?: number; status_msg?: string }; model_remains?: { model_name?: string }[] }
  callbacks.signal.throwIfAborted()
  if (data.base_resp?.status_code !== 0) {
    // MiniMax's own reason (not subscribed, wrong key, …) says more than a guess.
    const said = typeof data.base_resp?.status_msg === 'string' ? data.base_resp.status_msg.replace(/\s+/g, ' ').slice(0, 200) : ''
    throw new Error(`MiniMax menolak Subscription Key ini${said ? `: ${said}` : ''} (kode ${data.base_resp?.status_code ?? '?'}). Pastikan M Plan / Token Plan aktif di Plan Details dan key disalin dari sana. Tidak ada fallback ke wallet/PAYG.`)
  }
  const reported = Array.isArray(data.model_remains) ? data.model_remains.flatMap(row => typeof row.model_name === 'string' ? [row.model_name] : []) : []
  // M Plan shares one usage window across models and may list none (or only
  // non-chat ones); its text model is M3.1 Flash.
  const known = reported.filter(model => (MINIMAX_PLAN_MODELS as readonly string[]).includes(model))
  const models = known.length ? known : [MINIMAX_PLAN_MODELS[0]]
  return { accessToken: key, expiresAt: 0, meta: { planModels: JSON.stringify([...new Set(models)]) } }
}
