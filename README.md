# anticode

A desktop coding agent that runs on the subscriptions you already pay for.

No Anticode account, no sign-up, no middleman service. Install, connect your providers, and work.
Everything runs directly from your machine, with file, terminal, browser, and document tools
working inside your project, plus control from your phone.

**Why Anticode**

- **Your ChatGPT and Claude subscriptions.** Sign in through Auth provider and Anticode uses the
  quota of the plan you already have. No separate API billing, and no silent fallback to a paid route.
- **Dozens of accounts, one pool.** Add as many accounts per service as you need. Rotate usage
  picks an eligible account for each new prompt by how busy it is and how much it has used.
- **Usage control you can see.** Per-account quota windows and reset times as reported by the
  provider, a live routing map of the provider group serving requests, and local token and cost
  history kept separate from subscription quota.
- **Private by design.** Credentials live in your OS secure storage; provider and auth settings
  stay on your device.

Subscription access follows each provider's own terms. Anticode does not promise unlimited usage.

## Unduh

Ambil build terbaru dari halaman [Releases](https://github.com/fajrin77/anticode/releases/latest), lalu pilih berkas sesuai sistem operasi:

| Sistem | Berkas | Keterangan |
|---|---|---|
| macOS (Apple Silicon) | `anticode-<versi>-arm64.dmg` | Buka, lalu drag anticode ke Applications |
| macOS (Apple Silicon, zip) | `anticode-<versi>-arm64-mac.zip` | Alternatif tanpa mount dmg |
| Windows (64-bit) | `anticode Setup <versi>.exe` | Installer NSIS, jalankan langsung |

Setiap release juga memuat `latest-mac.yml` (macOS) dan `latest.yml` (Windows). Kedua berkas itulah yang dibaca updater untuk menawarkan versi baru, jadi menambah atau mengubah keterangan di sini tidak memengaruhi auto update: app yang sudah terpasang tetap menemukan dan memasang build baru lewat Settings -> Updates.

## Features

- **Multi-provider**: Codex, Claude, Cline and ClinePass, OpenRouter, Kilo, Vercel AI Gateway, MiniMax plan, OpenCode, Ollama, and any OpenAI-compatible endpoint. Credentials are encrypted in OS secure storage.
- **Full toolset**: files, terminal, web search, Playwright browser, screenshots, sub-agents, MCP, images, Excel, Word, and PDF.
- **Risk-based approval**: Default mode asks first; Auto mode runs without asking.
- **Two session modes**: *antichat* for questions without a project, *anticode* for working in a project folder.
- **From your phone**: open and control sessions from a phone browser on the same network.
- **Daily comfort**: automatic context compaction, checklists, checkpoints and Revert, menu bar quick capture, notifications, and automatic updates.

## Subscription dan akun

**Cline Free** dan **ClinePass** mempunyai grup Auth terpisah. ClinePass menampilkan batas 5 jam, mingguan, dan bulanan dari provider di Usage; koneksi plan lama dimigrasikan dengan ID sesi tetap.

Hubungkan akun lewat **Settings → Auth provider**. Anticode mendukung beberapa akun dan
routing kuota langsung di aplikasi, tanpa layanan 9Router terpisah. Model yang tersedia
mengikuti akses akun dan rute provider; login tidak menjamin semua model bisa digunakan.

Aktifkan **Subscription routing** untuk membatasi routing otomatis ke sumber subscription
atau gratis yang didukung. Kuota tetap mengikuti ketentuan provider; catatan token bulanan
di Anticode berbeda dari sisa kuota akun. Routing tidak boleh diam-diam beralih ke API berbayar.

Atur sakelar **Composer** di Settings → Providers atau Auth provider untuk memilih sumber
yang ditampilkan. Sumber baru tidak otomatis masuk daftar. Pilih modelnya di Settings → Models.
Beberapa akun pada layanan auth yang sama berbagi satu daftar model; request memakai akun
yang tersedia dengan mempertimbangkan kesibukan dan catatan usage lokal.

Provider API dapat menyimpan beberapa key lewat **Edit → Add API keys**. Key disimpan
terenkripsi dan berbagi daftar model yang sama. Menambah key tidak menjamin kuota terpisah
jika beberapa key berasal dari akun provider yang sama.

**OpenCode Go / Go Plus** disiapkan di Auth provider lewat plan key; matikan Extra usage di
OpenCode Console agar batas paket tidak beralih ke saldo PAYG. CodeBuddy menggunakan login
akun dan pembaruan token. Akses subscription nyata kedua layanan tetap perlu diverifikasi
dengan akun pengguna; keberhasilan fixture bukan bukti kuota provider.

Untuk pengembangan provider berikutnya, ikuti [panduan integrasi subscription](docs/SUBSCRIPTIONS.md).

## Setup

```bash
npm install
```

Untuk provider berbasis API key, salin `.env.example` menjadi `.env` dan isi kredensial yang
diperlukan, atau gunakan Settings → Providers. Untuk akun subscription, gunakan Settings →
Auth provider. Profil baru tidak mempunyai provider bawaan; koneksi dan kredensial
disimpan dalam profil lokal pengguna, bukan di repository atau paket pembaruan.

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
