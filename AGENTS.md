# Panduan kerja repository

Untuk perubahan pada provider, OAuth, katalog model, subscription, usage, atau routing akun,
baca dan ikuti [docs/SUBSCRIPTIONS.md](docs/SUBSCRIPTIONS.md) sebelum mengubah implementasi.

- Pertahankan koneksi langsung di Anticode dan batas subscription/gratis yang dipilih pengguna.
- Jangan membuat fallback otomatis ke rute berbayar atau mengasumsikan semua alias model
  mempunyai akses dan kapabilitas yang sama.
- Bedakan pengujian fixture, probe provider nyata, dan benchmark kemampuan coding ketika
  melaporkan hasil. Jangan menyimpan kredensial dalam kode, log, atau dokumentasi.
- Pertahankan pekerjaan lokal yang sudah ada dan jalankan pemeriksaan yang relevan dengan
  perubahan. Dokumentasi saja tidak memerlukan build atau pemasangan aplikasi baru.
