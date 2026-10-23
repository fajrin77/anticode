import { ProviderRequestError } from './requestError'

export class RetiredRouteError extends ProviderRequestError {
  readonly code = 'MODEL_ROUTE_RETIRED'
  constructor(model: string) {
    super(`Rute model ${model} sudah dihentikan oleh provider. Pilih rute lain yang masih tersedia. Rute berbayar tidak dipilih otomatis.`, 404)
    this.name = 'RetiredRouteError'
  }
}

/** Only explicit retirement, never a bare 404, missing endpoint or product restriction. */
export function isRetiredRoute(error: unknown): boolean {
  const pending = [error]
  let missing = false
  let retired = false
  for (let count = 0; count < 16 && pending.length; count++) {
    const item = pending.shift()
    if (!item || typeof item !== 'object') continue
    const row = item as { status?: unknown; code?: unknown; message?: unknown; error?: unknown; cause?: unknown }
    if (row.code === 'MODEL_ROUTE_RETIRED') return true
    missing ||= row.status === 404 || row.status === 410 || row.code === 404 || row.code === 410
    if (typeof row.message === 'string') {
      const text = row.message.slice(0, 65_536)
      missing ||= /(?:status|HTTP)\s+(?:404|410)\b/i.test(text)
      const json = text.indexOf('{')
      let primary = text
      if (json >= 0) {
        primary = text.slice(0, json)
        try { pending.push(JSON.parse(text.slice(json))) } catch { /* Never infer retirement from unparsed metadata. */ }
      }
      retired ||= /(?:model|variant|route)[^\n]{0,160}(?:retired|discontinued|decommissioned)|(?:retired|discontinued|decommissioned)[^\n]{0,100}(?:model|variant|route)/i.test(primary)
    }
    pending.push(row.error, row.cause)
  }
  return missing && retired
}
