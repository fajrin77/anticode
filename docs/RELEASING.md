# Merilis anticode dan update dari jauh

anticode sudah punya updater sendiri di `src/main/updater.ts` dan `src/main/updates.ts`.
Tidak ada Squirrel/electron-updater: build ini tidak ditandatangani, jadi app mengganti
bundelnya sendiri lewat helper kecil setelah user menekan **Restart to update**. Berkas
ini menjelaskan cara menyiapkan sisi distribusinya supaya update dari jauh benar-benar jalan.

## Cara kerjanya

1. **Sumber.** Tetap: repository `fajrin77/anticode`, dipatok di `src/main/updates.ts`
   (`OFFICIAL_REPO`) dan tidak bisa diubah dari Settings. Updater membaca daftar
   release repo itu dan memilih versi tertinggi — bukan tag "latest" GitHub —
   supaya release yang ditandai pre-release pun tetap terlihat.
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

`electron-builder.yml` sudah menunjuk GitHub Releases:
`provider: github`, `owner: fajrin77`, `repo: anticode`. Tidak ada server tambahan —
rilis baru cukup dibuat di halaman Releases repo itu, dan app terpasang menemukannya
melalui Settings -> Updates. Bila suatu saat ingin hosting sendiri (GitHub Pages, S3,
VPS), ganti blok `publish` menjadi `provider: generic` + `url: https://...` dan unggah
isi `release/` ke sana, termasuk berkas feed-nya.

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
3. Buat release di https://github.com/fajrin77/anticode/releases dengan tag `v<versi>`,
   lalu unggah seluruh isi `release/` sebagai asetnya — dmg/zip/exe, `.blockmap`, dan
   `latest-mac.yml`/`latest.yml`/`latest-linux.yml`. Dengan `gh`:
   ```
   gh release create v0.0.31 release/*.dmg release/*.zip release/*.exe release/*.blockmap release/latest*.yml
   ```
4. Tidak ada yang perlu diisi di app terpasang: sumbernya sudah dipatok. Update
   berjalan sendiri — cek tiap 6 jam — dan **Check automatically** /
   **Download automatically** mengatur apakah unduhan dilakukan otomatis.
   Saat menyusun release, tandai rilis sebagai **pre-release** pun tetap terbaca,
   karena updater membandingkan nomor versi, bukan label "latest".

Catatan: app harus berada di folder yang bisa ditulis (mis. `/Applications`) agar bisa
mengganti dirinya sendiri. Dev run tidak bisa memasang apa pun.