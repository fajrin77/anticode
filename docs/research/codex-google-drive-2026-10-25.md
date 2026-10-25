# Cara ChatGPT/Codex mengedit Google Drive (25 Oktober 2026)

Investigasi statis ChatGPT.app 26.1016.62342 (macOS arm64) yang terpasang, untuk meniru
kemampuan “Used Google Drive integration, edited a file” di Anticode. Tidak ada kredensial
atau isi Drive yang disimpan di catatan ini.

## Metode

- `app.asar` diekstrak ke folder sementara dan dibaca sebagai teks; tidak ada kode yang
  dijalankan. Biner `codex-cli/CodexCLI.app/.../codex` (Rust) dibaca dengan `strings`.
- REA 6.5.0 (`~/Downloads/rea-main`, `analyze-javascript-application` dengan
  `--source-path`) dijalankan dari folder kosong tanpa `setup`. Analisis sumber gagal di
  tahap startup: helper Swift REA tidak terkompilasi karena Command Line Tools di mesin ini
  mendefinisikan modul `SwiftBridging` dua kali. REA hanya menyimpan bukti parsial
  (inventaris dan digest). Temuan di bawah berasal dari pembacaan statis biasa, bukan dari
  dekompilasi REA.
- Cache katalog Codex `~/.codex/cache/codex_apps_tools/*.json` dibaca untuk nama dan
  skema tool.

## Temuan

1. ChatGPT.app adalah aplikasi Electron yang membundel Codex CLI. Konektor (Google Drive,
   Gmail, Calendar, GitHub, dan lainnya) tidak berjalan lokal. Codex membuka server MCP
   bernama `codex_apps` dengan transport `streamable_http`.
2. URL-nya `https://chatgpt.com/backend-api/ps/mcp` (server `plugin-runtime`). Endpoint lama
   `/backend-api/wham/apps` (`codex-connectors-mcp`) masih menjawab, tetapi tanpa tool Drive.
3. Autentikasinya token akun ChatGPT (`Authorization: Bearer`, `chatgpt-account-id`), yaitu
   identitas yang sama dengan provider ChatGPT (Codex) di Anticode. Izin OAuth Google
   disimpan di sisi ChatGPT, karena Drive dihubungkan di ChatGPT → Apps. Klien tidak pernah
   memegang token Google.
4. Katalog berisi 596 tool. Google Drive (`connector_5f3c8c41a1e54ad7a76272c89e2554fa`)
   menyediakan 45 tool, misalnya `google_drive.search`, `get_spreadsheet_range`,
   `batch_update_spreadsheet`, `batch_update_document`, `update_file`, `export_file` dan
   `upload_file`. Anotasi `readOnlyHint` dan `destructiveHint` tersedia.
5. Prompt sistem Codex menyuruh model memakai konektor Drive untuk dokumen Google Workspace
   dan memakai konteks tab browser hanya sebagai cadangan.

## Probe nyata (terbatas, read-only)

Tanggal 25 Oktober 2026, memakai login Codex di mesin ini. Ketiga langkah dijalankan dua
kali: dengan skrip probe dan dengan `HttpTransport` + `McpClient` milik Anticode.

| Langkah | Hasil |
|---|---|
| `initialize` ke `/backend-api/ps/mcp` | 200, `plugin-runtime 0.1.0` |
| `tools/list` | 596 tool, 45 `google_drive.*` (29 read-only) |
| `tools/call google_drive.get_profile` | 200, `isError: false` |

Belum ada tool tulis yang dipanggil dalam probe. Pengeditan sungguhan baru terjadi saat
pengguna memintanya di sesi, melalui gerbang persetujuan.

## Konektor claude.ai (Claude Code 2.1.307)

Dibaca statis dari biner `~/.local/share/claude/versions/2.1.307`:

- Daftar konektor: `GET https://api.anthropic.com/v1/mcp_servers?limit=1000` dengan token OAuth
  akun Claude, `anthropic-version: 2023-06-01` dan `anthropic-beta: mcp-servers-2025-12-04`.
  Token wajib punya scope `user:mcp_servers`, dan login Claude Anticode sudah memintanya.
- Tiap konektor dicapai lewat proxy `https://mcp-proxy.anthropic.com/v1/mcp/{server_id}`
  (transport `claudeai-proxy`, HTTP streamable). Entri dengan `eligible: false` dilewati.
- Probe nyata belum bisa dilakukan. Token Claude Code di keychain Mac ini sudah dicabut (401),
  dan token akun Claude di Anticode tersegel safeStorage, jadi hanya bisa dibuka di dalam
  aplikasi. Token Claude Code sengaja tidak di-refresh agar login Claude Code tidak rusak.

Akun Cline, ClinePass, Kilo, CodeBuddy, OpenRouter dan lainnya tidak punya konektor yang
di-host, sehingga tidak ada yang bisa dipakai ulang.

## Implementasi di Anticode

- `src/main/mcp/accountConnectors.ts` mengikuti akun yang sedang dipakai sesi
  (`provider.id`, ikut berpindah saat Rotate usage berganti akun):
  - Akun ChatGPT (Codex) memakai semua app dari ChatGPT → Apps lewat `/backend-api/ps/mcp`,
    kecuali plumbing internal ChatGPT (Plugin Management, Safety Settings, Codex Document
    Control, Pets, Hotline, Search Service).
  - Akun Claude memakai konektor claude.ai lewat proxy di atas.
  - Provider lain tidak mendapat konektor.
- Karena satu akun bisa membawa ratusan tool (ChatGPT: 569, Vercel saja 240), tiap konektor
  dimuat per nama: `load_tools({ connectors: ["Google Drive"] })`. Deskripsi `load_tools`
  menyebut konektor yang tersedia untuk akun sesi itu. Konektor yang pernah dipakai
  dimuat ulang dari riwayat saat sesi dibuka kembali.
- Tool baca berisiko rendah, tool tulis meminta persetujuan kecuali mode Auto aktif, dan
  tool destruktif selalu meminta persetujuan.
- Tidak ada fallback berbayar atau identitas baru: header sama dengan provider akun itu.
  Setelah gagal, koneksi dicoba lagi paling cepat 60 detik kemudian.
- Probe nyata ChatGPT lewat modul ini: 569 tool di 10 konektor, dan
  `google_drive.get_profile` berhasil.

Keterbatasan: endpoint ini internal OpenAI dan Anthropic, dan dapat berubah tanpa pemberitahuan.
