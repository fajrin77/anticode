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

## Rilis baru: hapus artefak versi lama di `release/` (WAJIB, hemat SSD)

Folder `release/` (output electron-builder, di-gitignore) cepat membengkak: tiap versi
menghasilkan zip + dmg + exe + `.blockmap` + folder unpacked (`mac-arm64/`, `win-unpacked/`).
Jika versi lama tidak dibersihkan, folder ini bisa tumbuh hingga belasan GB dan memenuhi SSD.

Aturan setiap kali rilis versi baru:

1. Selesaikan rilis dulu: `npm run release` (atau `npm run publish:mac`), lalu pastikan
   seluruh aset + feed (`latest-mac.yml` / `latest.yml` / `latest-linux.yml`) sudah
   terunggah ke GitHub Release `fajrin77/anticode` (tag `v<versi>`). Updater di app
   terpasang membaca aset GitHub, bukan folder lokal.
2. Setelah upload terverifikasi, hapus dari `release/` semua artefak yang tidak menyandang
   versi terbaru (`version` di `package.json`):
   - file `anticode-<versi-lama>-*` (`.zip`, `.dmg`, `.exe`, `.blockmap`)
   - folder unpacked sisa build: `mac-arm64/`, `win-unpacked/`
3. Pertahankan hanya artefak versi terbaru + file feed-nya. Jangan hapus `release/`
   sebelum upload selesai, dan jangan hapus `build/` (resource ikon).
4. Verifikasi: `du -sh release/` harus ± 1 GB (bukan puluhan GB), dan cek
   `df -h /System/Volumes/Data` bahwa ruang tersisa cukup.

Contoh (saat versi terbaru = 0.1.12):
```sh
cd release
find . -maxdepth 1 -type f ! -name "*0.1.12*" -delete
rm -rf mac-arm64 win-unpacked
```
