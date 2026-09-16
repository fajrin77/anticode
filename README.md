# anticode

AI coding agent desktop app. Satu aplikasi Electron untuk mengobrol dan bekerja dengan berbagai
provider AI — dengan tool file, terminal, browser, dan dokumen yang dijalankan langsung di project
Anda, plus akses dari HP.

## Unduh

Ambil build terbaru dari halaman [Releases](https://github.com/fajrin77/anticode/releases/latest), lalu pilih berkas sesuai sistem operasi:

| Sistem | Berkas | Keterangan |
|---|---|---|
| macOS (Apple Silicon) | `anticode-<versi>-arm64.dmg` | Buka, lalu drag anticode ke Applications |
| macOS (Apple Silicon, zip) | `anticode-<versi>-arm64-mac.zip` | Alternatif tanpa mount dmg |
| Windows (64-bit) | `anticode Setup <versi>.exe` | Installer NSIS, jalankan langsung |

Setiap release juga memuat `latest-mac.yml` (macOS) dan `latest.yml` (Windows). Kedua berkas itulah yang dibaca updater untuk menawarkan versi baru, jadi menambah atau mengubah keterangan di sini tidak memengaruhi auto update — app yang sudah terpasang tetap menemukan dan memasang build baru lewat Settings -> Updates.

## Fitur

- **Multi-provider** — lima provider di belakang satu abstraksi; tambah lewat Settings, kredensial disimpan terenkripsi di secure storage OS.
- **Tool lengkap** — file, terminal, pencarian web, browser Playwright, screenshot, sub-agent, MCP, gambar, serta Excel, Word, dan PDF.
- **Approval berbasis risiko** — setiap tool punya tingkat risiko; mode Default meminta konfirmasi, mode Auto berjalan tanpa bertanya sama sekali.
- **Dua mode sesi** — *antichat* untuk tanya jawab tanpa project (folder privat per sesi), *anticode* untuk bekerja di folder project.
- **Dari HP** — buka dan kendalikan sesi dari browser ponsel di jaringan yang sama, lengkap dengan transkrip, approval, dan lampiran.
- **Kenyamanan harian** — automatic context compaction, checklist, checkpoint/Revert, menu bar + quick capture, notifikasi sistem, dan update otomatis.

## Setup

```bash
npm install
```

Salin `.env.example` menjadi `.env`, lalu isi kredensial provider yang mau dipakai. Provider tanpa
kredensial tetap tampil di UI tetapi dinonaktifkan dengan alasan yang jelas.

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Dev server + Electron (HMR) |
| `npm test` | Test tool, kebijakan risiko, dan agent loop (Vitest) |
| `npm run typecheck` | Typecheck main/preload/shared dan renderer |
| `npm run build` | Typecheck lalu bundle ke `out/` |
| `npm run pack:mac` / `pack:win` / `pack:linux` | Installer via electron-builder ke `release/` |

## Mulai

1. Jalankan `npm run dev`.
2. Di dashboard pilih mode **antichat** atau **anticode** (pilih folder project dulu).
3. Beri instruksi; tool berisiko memunculkan dialog konfirmasi di mode Default.

Shortcut global **Cmd/Ctrl+Shift+Space** memunculkan anticode; **Cmd/Ctrl+Alt+Space** membuka quick capture.

## Remote (HP)

Dari Settings, aktifkan remote lalu buka alamat yang tampil di browser ponsel (jaringan yang sama).
Transkrip, steer, approval, dan lampiran tersedia dari HP; sesi yang dibaca terus tersinkron dengan
desktop.

## Keamanan

- Approval mengikuti mode: Default meminta konfirmasi pada aksi yang mengubah sesuatu, Auto berjalan tanpa kartu.
- File tool antichat terkunci di folder privat sesi; anticode terkunci di folder project.
- API key disimpan terenkripsi lewat secure storage OS, tidak pernah ditulis ke disk polos.
- Browser remote memakai token sesi; akses hanya dari jaringan lokal.

## Rilis

Lihat [Releases](https://github.com/fajrin77/anticode/releases) untuk versi terbaru dan catatan perubahannya.
