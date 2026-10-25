# Status integrasi Auth tambahan

## GitHub Copilot

Device authorize menggunakan identitas aplikasi publik OpenCode
`Ov23li8tweQw6odWQebz` sesuai pilihan pengguna sebelumnya, bukan identitas Anticode
yang didaftarkan sendiri. Tidak ada client secret. Alur dapat dibatalkan dan memeriksa
akses katalog sebelum menyimpan token. Inference langsung ke `api.githubcopilot.com`,
tanpa fallback GitHub Models berbayar. Model harus secara eksplisit mendukung
`/chat/completions` dan tidak dinonaktifkan. Responses-only belum didukung.

Vercel tidak ditawarkan untuk akun baru; akun Vercel lama tidak dihapus.
Fixture memeriksa filtering katalog, subscription ditolak, dan pembatalan authorize.
UI Electron membuktikan tombol Copilot tampil, Vercel tidak ditawarkan lagi.
**Authorize dan inference akun nyata belum terverifikasi**: memerlukan persetujuan
pengguna di GitHub dan akun Copilot yang mengizinkan client ini.

## Cursor dan Antigravity

Keduanya sudah dihubungkan ke Auth, secure storage akun, katalog live dan adapter
inference. Tidak ada nama model rekaan; katalog kosong sampai akun mengembalikan
model yang didukung. Token pengguna tidak ditulis ke log atau konfigurasi CLI.

Cursor memakai authorize browser PKCE `loginDeepControl` dan polling; memerlukan
CLI resmi yang sudah terpasang atau `ANTICODE_CURSOR_CLI` menunjuk executable.
Tidak ada unduhan otomatis, CLI tidak dibundel dalam installer. CLI dijalankan
dalam direktori/profil sementara, credential store memory, mode ask, tanpa `--force`;
native tool ditolak lewat allowlist kosong/denylist. Environment tidak mewariskan
API key provider lain atau konfigurasi MCP pengguna. Model mengembalikan request
tool JSON untuk diproses tool Anticode, termasuk konektor bersama dan approval.
Ini adapter text/tool dengan output buffered, bukan dukungan vision/streaming asli.
Alias `auto` tidak ditawarkan. Token kedaluwarsa meminta authorize ulang; endpoint
refresh Cursor tidak ditebak. Dukungan CLI bergantung versi dan platform instalasi.

Antigravity memakai browser authorization-code PKCE dan callback localhost port
51121, validasi state, token exchange/refresh Google dan proyek managed dari
`loadCodeAssist`. Kredensial client OAuth tidak dibundel atau disimpan dalam repo.
Operator harus memasok `ANTICODE_ANTIGRAVITY_CLIENT_ID` dan
`ANTICODE_ANTIGRAVITY_CLIENT_SECRET` melalui environment lokal (lihat `.env.example`),
lalu restart aplikasi. Tanpa konfigurasi ini, login berhenti dengan pesan yang jelas;
authorize akun tetap melalui browser, bukan tempel token akun. Ini persyaratan
rilis 0.0.97 untuk menghindari distribusi kredensial pihak ketiga.
Tidak membuat Cloud project/onboarding berbayar: akun harus sudah diaktifkan dalam
aplikasi resmi. Hanya katalog Gemini didukung, bukan alias Claude Antigravity.
Inference memakai envelope Cloud Code `generateContent`, buffered. Token/call
dikembalikan ke loop tool Anticode, tidak ada fallback ke API key Google berbayar.

Fixture mencakup PKCE/state, penolakan login, expiry, refresh dan metadata proyek,
filter katalog, response/tool/usage, serta subprocess CLI tiruan: profil terisolasi,
tanpa secret environment lain, denylist native tool, dan pembersihan file.
**Login/inference provider nyata belum terverifikasi**: memerlukan authorize browser
oleh pemilik akun dan subscription/client entitlement yang sesuai. Keberhasilan
fixture tidak membuktikan upstream menerima identitas atau model akun tersebut.

Sumber: OpenCode.app lokal, https://github.com/anomalyco/opencode/,
https://raw.githubusercontent.com/sst/opencode-copilot-auth/main/index.mjs,
https://raw.githubusercontent.com/NoeFabris/opencode-antigravity-auth/main/src/constants.ts.

## Browser gelap

Canvas webview dan kontainer memakai latar gelap. Error navigasi tampil sebagai
overlay memenuhi area browser, mengikuti tema aplikasi. Situs yang berhasil dimuat
tetap mengatur desainnya sendiri. Electron memeriksa warna canvas dan simulasi
`did-fail-load`, termasuk luas overlay dan warna tema. Simulasi event bukan probe
kegagalan jaringan nyata.

Verifikasi terbaru: typecheck/build lolos; 266 pemeriksaan UI Electron lolos,
termasuk ketiga opsi Auth dan browser gelap. 822 tes dari 80 berkas lolos.
Tidak ada benchmark coding provider nyata pada tahap ini.

Rilis 0.0.97 juga menyelaraskan Input, Cache, dan Output rincian harian dalam
kolom grid bersama per model, sehingga panjang angka berbeda tidak menggeser kolom.
