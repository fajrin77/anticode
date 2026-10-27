import { failureStatus } from './failures'
import { InputRequestLimitError, requestLimit } from './requestLimits'
import { isRetiredRoute, RetiredRouteError } from './routeError'

/** UI/durable display boundary: never echo serialized upstream metadata or ids. */
export function safeProviderErrorMessage(error: unknown, model = 'ini'): string {
  const limit = requestLimit(error)
  if (limit?.kind === 'input') return new InputRequestLimitError(limit.promptTokens ?? 0, limit.limitTokens ?? 0, error instanceof InputRequestLimitError && error.minimumRequest).message
  if (limit?.kind === 'payload') return 'Request melebihi batas ukuran provider (HTTP 413). Gambar asli dan hasil pekerjaan tetap tersimpan. Ringkas percakapan atau kurangi lampiran terbaru sebelum mencoba kembali. Batas paket gratis tidak dinaikkan otomatis dan tidak dialihkan ke rute berbayar.'
  if (isRetiredRoute(error)) return new RetiredRouteError(model).message
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'Provider menolak request.'
  const status = failureStatus(error)
  if (status === 403) return 'Provider menolak akses ke rute model ini (HTTP 403); belum tentu kuota habis. Rotate dapat melanjutkan ke rute lain yang memenuhi syarat dalam pool pilihan Anda. Jika tidak ada rute tersedia, periksa izin model, akun/key, atau endpoint di Settings → Providers. Rute yang ditolak tidak diulang dan tidak ditambahkan fallback berbayar.'
  if (/[{[]\s*"|\b(?:user_id|account_id|org_id|metadata|previous_errors)\b|<html/i.test(message)) {
    return `Provider menolak request${status !== undefined ? ` (HTTP ${status})` : ''}. ${status === 404 ? 'Rute atau endpoint tidak tersedia; perbarui katalog model dan periksa koneksi provider.' : 'Periksa akses model dan status provider, lalu coba kembali.'}`
  }
  return message.replace(/\bBearer\s+[^\s"']+|\bsk-[\w-]+/gi, '[credential redacted]').slice(0, 2000)
}
