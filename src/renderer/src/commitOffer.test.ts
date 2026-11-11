import { expect, it } from 'vitest'
import { commitOffer } from './commitOffer'
import type { Message } from './store/session'

function answer(text: string, patch: Partial<Message> = {}): Message {
  return { id: 'answer', role: 'assistant', pending: false, parts: [{ kind: 'text', text }], summary: {} as NonNullable<Message['summary']>, ...patch }
}

it('offers commit and push only for a finished current invitation', () => {
  expect(commitOffer([answer('Mau lanjut commit dan push?')])).toBe('answer')
  expect(commitOffer([answer('Ready to commit & push.')])).toBe('answer')
  expect(commitOffer([answer('Commit dan push belum dilakukan.')])).toBe('answer')
  expect(commitOffer([answer('Sudah diperbaiki dan di-commit: 0312a04. Belum push; perubahan masih lokal. Boleh saya push ke `main` dan cek deploy sampai READY?')])).toBe('answer')
  expect(commitOffer([answer('Boleh saya push ke main?')])).toBe('answer')
  expect(commitOffer([answer('Mau saya commit perubahan ini?')])).toBe('answer')
  expect(commitOffer([answer('Commit dan push berhasil.')])).toBeNull()
  expect(commitOffer([answer('Mau lanjut commit dan push?', { pending: true })])).toBeNull()
  expect(commitOffer([answer('Mau lanjut commit dan push?'), answer('OK', { role: 'user' })])).toBeNull()
  expect(commitOffer([answer('Run git push to publish.')])).toBeNull()
})
