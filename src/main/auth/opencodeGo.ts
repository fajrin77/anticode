import { shell } from 'electron'
import { GO_BASE, goHeaders } from '../providers/opencodeGo'
import type { AuthLoginCallbacks, AuthTokens } from './types'

export async function loginOpenCodeGo(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const url = 'https://opencode.ai/console'
  callbacks.onUpdate({ message: 'Sign in to the Console, pick a workspace with Go / Go Plus active, then copy the key and paste it back into Anticode. The dashboard alone does not connect the account. Turn off Extra usage to stay within the plan limit.', url })
  void shell.openExternal(url)
  const key = (await callbacks.promptForCode('Paste your OpenCode Go plan key')).trim()
  callbacks.signal.throwIfAborted()
  if (!key || /\s/.test(key)) throw new Error('Enter a valid OpenCode Go plan key.')
  const response = await fetch(`${GO_BASE}/v1/models`, {
    headers: { ...goHeaders('anticode-connect'), authorization: `Bearer ${key}` },
    signal: AbortSignal.any([callbacks.signal, AbortSignal.timeout(15000)])
  })
  if (!response.ok) throw new Error(`OpenCode Go could not validate this key (HTTP ${response.status}). Check the key and active Go subscription.`)
  return { accessToken: key, expiresAt: 0 }
}
