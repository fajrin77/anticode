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

## Implementasi di Anticode

- `src/main/mcp/chatgptApps.ts` menghubungkan akun ChatGPT (Codex) pertama yang tersimpan ke
  endpoint di atas. Header (token yang diperbarui otomatis) diambil ulang setiap request.
- Hanya tool `google_drive.*` yang ditawarkan, dengan nama `mcp__Google_Drive__…` di grup
  `integrations` pada `load_tools`. Tool baca berisiko rendah, tool tulis meminta persetujuan
  kecuali mode Auto aktif, dan tool destruktif selalu meminta persetujuan.
- Tidak ada fallback berbayar atau identitas baru. Header sama dengan provider Codex
  Anticode. Bila akun ChatGPT belum ada atau Drive belum dihubungkan di ChatGPT, tool tidak
  muncul atau mengembalikan pesan yang jelas. Setelah gagal, koneksi dicoba lagi paling
  cepat 60 detik kemudian.

Keterbatasan: endpoint ini internal OpenAI dan dapat berubah tanpa pemberitahuan.
