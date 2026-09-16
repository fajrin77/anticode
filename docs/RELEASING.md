# Merilis anticode dan update dari jauh

anticode sudah punya updater sendiri di `src/main/updater.ts` dan `src/main/updates.ts`.
Tidak ada Squirrel/electron-updater: build ini tidak ditandatangani, jadi app mengganti
bundelnya sendiri lewat helper kecil setelah user menekan **Restart to update**. Berkas
ini menjelaskan cara menyiapkan sisi distribusinya supaya update dari jauh benar-benar jalan.

## Cara kerjanya

1. **Sumber.** User mengisi Settings -> Updates dengan salah satu dari:
   - repository GitHub (`owner/repo` atau URL-nya) — release terbaru beserta asetnya;
   - URL feed electron-builder (folder, atau langsung `latest-mac.yml`/`latest.yml`/`latest-linux.yml`);
   - folder lokal berisi build, misalnya `release/` project ini.
2. **Pemeriksaan.** `initUpdates()` menjadwalkan cek pertama 20 detik setelah start-up,
   lalu tiap 6 jam. `checkForUpdates()` memanggil `findLatest()`, yang membaca release GitHub,
   feed YAML, atau nama berkas `anticode-<versi>-<arch>.<ext>` di folder, lalu membandingkan
   versinya dengan `APP_VERSION` (dari `package.json`).
3. **Unduh.** Bila ada versi lebih baru, `download()` menyalin build ke
   `userData/updates/` dan mencocokkan sha512 bila sumber mencantumkannya. Unduhan yang
   tidak cocok dibuang. Build lama dipangkas oleh `pruneOldDownloads()`.
4. **Pasang.** Hanya saat user menekan **Restart to update**. `install()` menutup app,
   menunggu proses benar-benar keluar, lalu mengganti bundel — dmg di-mount / zip dibuka,
   NSIS dijalankan senyap di Windows, AppImage diganti di Linux. Bundel lama dikembalikan
   bila penyalinan gagal.

## Menyiapkan hosting

`electron-builder.yml` sudah memakai provider `generic`. Ganti `publish.url` ke alamat
tempat Anda meng-host folder `release/` (GitHub Pages, S3, VPS, dsb.), atau pakai GitHub
Releases: ganti blok `publish` menjadi `provider: github` dan isi `owner`/`repo`.

Setiap kali build, electron-builder menulis file feed (`latest-mac.yml` untuk macOS,
`latest.yml` untuk Windows, `latest-linux.yml` untuk Linux) ke `release/`. File itu memuat
versi, nama berkas, dan sha512 — inilah yang dibaca updater.

## Rilis versi baru

1. Naikkan `version` di `package.json` (mis. `0.0.30` -> `0.0.31`). Ini yang dibaca
   `APP_VERSION`, jadi versi build dan versi yang dilaporkan updater selalu sama.
2. Build ketiga platform:
   ```
   npm run release
   ```
   Hasilnya ada di `release/` bersama file feed-nya.
3. Unggah seluruh isi `release/` (bukan hanya satu berkas) ke sumber yang Anda pilih,
   termasuk `latest-mac.yml`/`latest.yml`/`latest-linux.yml`.
4. Di app yang sudah terpasang, isi Settings -> Updates dengan alamat sumber itu sekali
   saja. Setelah itu update dari jauh berjalan sendiri: cek tiap 6 jam, dan **Check
   automatically** / **Download automatically** mengatur apakah unduhan dilakukan otomatis.

Catatan: app harus berada di folder yang bisa ditulis (mis. `/Applications`) agar bisa
mengganti dirinya sendiri. Dev run tidak bisa memasang apa pun.