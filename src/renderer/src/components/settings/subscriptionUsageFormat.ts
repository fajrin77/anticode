export function quotaWindowLabel(label: string): string {
  return ({ Weekly: 'Mingguan', Monthly: 'Bulanan', '5-hour window': 'Batas sesi', '7-day window': 'Mingguan · semua model', 'Opus 7-day window': 'Mingguan · Opus', 'Sonnet 7-day window': 'Mingguan · Sonnet', 'OAuth apps 7-day window': 'Mingguan · aplikasi OAuth', 'Primary window': 'Batas utama', 'Secondary window': 'Batas tambahan' } as Record<string, string>)[label] ?? label
}

export function quotaResetLabel(resetAt: number | null, now: number): string {
  if (resetAt === null || !Number.isFinite(resetAt)) return 'Waktu reset belum tersedia'
  const remaining = resetAt - now
  if (remaining <= 0) return 'Menunggu pembaruan kuota'
  if (remaining < 24 * 60 * 60 * 1000) {
    const minutes = Math.ceil(remaining / 60000)
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return `Reset dalam ${hours ? `${hours} jam${rest ? ' ' : ''}` : ''}${rest ? `${rest} menit` : ''}`
  }
  if (remaining >= 7 * 24 * 60 * 60 * 1000) return `Reset ${new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(resetAt)}`
  return `Reset ${new Intl.DateTimeFormat('id-ID', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(resetAt)}`
}
