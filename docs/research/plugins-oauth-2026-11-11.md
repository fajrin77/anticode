# Plugin OAuth: Claude Desktop, Codex, dan Anticode — 11 November 2026

## Bukti paket (REA skill `reverse-engineer-anything`, rute JavaScript/Electron)

- **Claude Desktop** (`/Applications/Claude.app`, `app.asar` diekstrak ke direktori
  sementara, `.vite/build/index.chunk-BV3uOqbK.js`): konektor MCP memakai klien OAuth
  dari MCP TypeScript SDK. Discovery `/.well-known/oauth-protected-resource` (header
  `resource_metadata`), metadata authorization server, lalu dynamic client registration
  dengan `client_name: "Claude Desktop (<versi>)"`, `redirect_uris: [loopback]`,
  `grant_types: [authorization_code, refresh_token]`, `token_endpoint_auth_method: none`.
  Server tanpa registration memakai jalur "BYO" (client ID/scope milik pengguna).
- **Codex** (`ChatGPT.app/Contents/Resources/codex-cli`, versi 0.167.0-alpha.3.2, biner
  Rust; string dibaca, bukan dieksekusi): manifest plugin `.codex-plugin/plugin.json`
  (juga membaca `.claude-plugin/` dan `.cursor-plugin/`) yang menggabungkan skills,
  `.mcp.json`, `.app.json`, hooks dan subagents. OAuth MCP: discovery yang sama, pesan
  "Dynamic client registration not supported", callback `/callback`, opsi
  `mcp_oauth_callback_port`, token di keyring "Codex MCP Credentials" dengan refresh.

Kesimpulan: "plugin" di kedua aplikasi pada dasarnya server MCP remote + OAuth standar
MCP, satu kredensial per server. Anticode meniru pola ini dengan identitas sendiri
(`client_name: Anticode`), tanpa meminjam client ID aplikasi lain.

## Probe nyata (tanpa kredensial, 11 November 2026)

Discovery + registration dengan `oauth.ts` Anticode:

| Plugin | Discovery | Registration |
| --- | --- | --- |
| GitHub (`api.githubcopilot.com/mcp/`) | ok | tidak ada → device flow dengan client ID OAuth App pengguna, atau PAT |
| Supabase, Neon | ok | ok (server mengembalikan client secret) |
| Vercel, Linear, Notion, Sentry, Stripe, Cloudflare, Netlify, Atlassian | ok | ok |
| Figma | ok | HTTP 403 — tidak dimasukkan ke katalog |

Belum dibuktikan: login browser sampai token dan pemanggilan tool pada akun nyata
(butuh interaksi pengguna). Fixture `src/main/plugins/plugins.test.ts` membuktikan
alur lengkap terhadap server OAuth + MCP lokal: PKCE, refresh, beberapa akun, ganti
akun aktif, login ulang identitas sama tanpa slot baru, token tersegel di disk.

## Implementasi

- `src/main/plugins/oauth.ts`: discovery, registration, login loopback PKCE, refresh,
  device flow GitHub.
- `src/main/plugins/index.ts`: katalog, akun (`plugins.json`, token disegel OS),
  satu akun aktif per plugin, koneksi MCP, tool `plugin__<nama>__<tool>` dengan
  connector `<Nama> plugin` sehingga dimuat lewat `load_tools` oleh model apa pun.
- Settings → Plugins: dropdown akun per plugin, tambah akun, ganti nama/hapus akun,
  sakelar, client ID GitHub, PAT, dan server MCP OAuth lain lewat URL.
