# Perbaikan 0.1.10

- Rotate dapat melanjutkan ke rute lain yang memenuhi syarat dalam pool pilihan pengguna setelah inference ditolak HTTP 403 sebelum menghasilkan output. Rute yang sama tidak dicoba berulang dalam handover; batas subscription/gratis dan pemeriksaan keamanan tetap berlaku. Tidak ditambahkan fallback berbayar.
- Rangkuman Changed files langsung tampil di bawah jawaban terbaru setelah pekerjaan selesai atau terhenti, selama ada perubahan file, tanpa menunggu giliran percakapan berikutnya.
- Rangkuman tetap tersedia dalam riwayat dan setelah pindah tab, tanpa duplikasi.

Verifikasi rotasi memakai fixture, bukan probe provider nyata. Respons 403 tidak selalu berarti kuota habis; izin upstream tidak diubah oleh rilis ini.
