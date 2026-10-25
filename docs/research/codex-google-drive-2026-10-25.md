# Konektor ChatGPT dan claude.ai di Anticode (25 Oktober 2026)

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
- Proxy mewajibkan header `X-Mcp-Client-Session-Id` (UUID per koneksi). Tanpa header itu
  jawabannya HTTP 400 `header.X-Mcp-Client-Session-Id: Field required`. Ini ditemukan
  lewat probe nyata dan sudah diperbaiki.

### REA pada Claude.app 3.6556.2

REA 6.5.0 sekarang berjalan. Helper Swift REA dikompilasi lewat wrapper
`REA_DARWIN_SWIFTC_PATH`, yang menyembunyikan `bridging.modulemap` ganda milik Command Line
Tools dengan VFS overlay, tanpa mengubah file sistem. `analyze-javascript-application` pada
`.vite/build/index.chunk-0EQutPPD.js` (1,2 MB) selesai dengan exit 0: 317.720 node AST,
20.552 node semantik, dan 136 temuan. Fungsi yang relevan:

- `oauthTokenFromFd` dan `oauthScopesFromFd`: Claude.app memberi token OAuth akun ke Claude
  Code bawaannya lewat file descriptor.
- `setMcpServers`, `connectSdkMcpServer`, `mcpServerStatus`: server MCP dikelola melalui
  Claude Code. Konektor claude.ai dimuat oleh Claude Code sendiri dengan
  `MCP_PROXY_URL: "https://mcp-proxy.anthropic.com"` dan `MCP_PROXY_PATH: "/v1/mcp/{server_id}"`
  (konfigurasi yang sama dengan di biner CLI).

### Probe nyata konektor Claude dan ChatGPT di Electron (25 Oktober 2026)

Proses Electron bernama `anticode` membuka token akun Anticode yang tersegel lewat
`safeStorage`, dari profil asli secara read-only. Profil Chromium-nya dibuat sementara. Kode
yang dijalankan adalah `accountConnectors.ts` asli; auth store diganti stub yang tidak pernah
me-refresh atau menulis token. Hanya tool baca yang dipanggil.

| Akun | Konektor | Panggilan baca |
|---|---|---|
| ChatGPT (`auth:codex`) | 569 tool: Vercel 240, GitHub 91, Canva 45, Google Drive 45, Lovable 41, Sites 39, Supabase 29, Gmail 21, Google Calendar 15, Google Contacts 3 | `google_drive.get_profile` OK |
| Claude (`auth:claude`) | 292 tool: Vercel 244, Supabase 29, Google Drive 11, Claude Docs 8 | Drive `list_recent_files` OK |
| Claude (`auth:claude-2`) | 19 tool: Google Drive 11, Claude Docs 8. Airtable gagal 401 karena izinnya di claude.ai sudah kedaluwarsa; konektor lain tetap jalan | Drive `list_recent_files` OK |
| Cline (5 akun) | Tidak ada, sesuai rancangan | - |

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

### Konektor bersama untuk semua model

Konektor tidak lagi dibatasi pada akun yang sedang dipakai sesi. Semua konektor dari semua akun
ChatGPT dan Claude yang tersimpan tersedia untuk setiap model (Cline, Kilo, OpenRouter, dan
lainnya). Pemanggilan konektor memakai token akun pemilik konektor, bukan inference, jadi
tidak memindahkan rute model ke jalur berbayar.

- Urutan mengikuti urutan akun tersimpan agar nama tetap stabil saat Rotate usage berganti
  akun dan saat sesi dibuka kembali. Akun pertama memakai nama polos ("Google Drive"). Konektor
  yang sama di akun berikutnya diberi label akun, misalnya "Google Drive (claude-2)" dengan nama
  tool `mcp__claude-2_Google_Driv__…` (label akun di depan karena prefix dipotong 20 karakter).
- Probe nyata di Electron: sesi akun Cline mendapat 880 tool dari 16 konektor (ChatGPT 10,
  `auth:claude` 4, `auth:claude-2` 2), dan `list_recent_files` Google Drive milik `claude-2`
  berhasil dari sesi Cline itu.

Keterbatasan: endpoint ini internal OpenAI dan Anthropic, dan dapat berubah tanpa pemberitahuan.
