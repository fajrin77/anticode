import { describe, expect, it } from 'vitest'
import { narrationsAlike } from './loop'

const words = (text: string): string[] => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)

describe('narrationsAlike', () => {
  it('catches the same announcement reworded', () => {
    expect(narrationsAlike(
      words('Saya kembalikan dulu hasil restore kemarin, lalu petakan kewajiban vs cashflow dari nama dan total bayar.'),
      words('Saya kembalikan dulu hasil restore kemarin, lalu saya petakan kewajiban vs cashflow dari nama dan nilai.')
    )).toBe(true)
    expect(narrationsAlike(
      words('Rollback terverifikasi. Sekarang saya baca fungsi trigger penghitung.'),
      words('Rollback terverifikasi. Sekarang saya cek bagaimana pembayaran dihitung.')
    )).toBe(true)
  })
  it('leaves distinct steps alone', () => {
    expect(narrationsAlike(words('Saya baca file konfigurasi untuk melihat port.'), words('Sekarang tes dijalankan untuk memastikan perbaikan lulus.'))).toBe(false)
  })
})
