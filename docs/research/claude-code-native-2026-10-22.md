# Claude 5.5 melalui mesin resmi — 22 Oktober 2026

## Temuan nyata

Screenshot membedakan dua provider: `cc/claude-sonnet-5` berhasil melalui Claude
OAuth, sedangkan `cl/anthropic/claude-sonnet-5.5` mendapat 401 dari Cline. Token
Cline dan subscription Claude bukan sumber akses yang sama.

9Router terpasang versi 0.5.81. API key lokalnya mengautentikasi klien terhadap
router; request upstream Claude memakai Bearer OAuth akun Claude. Label `EST.
COST` pada dashboard adalah estimasi, bukan bukti tagihan API aktual. Pada probe,
profil menyatakan subscription aktif dan Extra usage nonaktif.

Probe dengan identitas Anticode melalui HTTP langsung mendapat 429 generik
`rate_limit_error` pada Sonnet 5, Sonnet 5.5, dan Opus 5.5. Tidak ada dasar untuk
menyimpulkan kuota habis atau akses semua model ditolak. Menambahkan parameter
protokol beta tidak mengatasi respons tersebut.

Melalui 9Router, `cc/claude-sonnet-5-5` berhasil menghasilkan teks dan melewati
satu tool round trip dengan jawaban streaming. ID resmi memakai `5-5`, berbeda
dari ID Cline. `cc/claude-opus-5-5` mendapat 400 dengan kode
`claude_code_version_too_old`: identitas klien 2.1.258 yang dikirim router
memerlukan pembaruan ke minimal 2.1.280. CLI lokal yang terpisah sebelumnya
2.1.178; setelah persetujuan pengguna diperbarui ke 2.1.307.

Pemeriksaan paket menemukan header identitas `claude-cli` dan `X-App: cli`.
Sumber referensi 9Router juga memuat fungsi cloaking. Anticode tidak menyalin
penyamaran tersebut; pengguna memilih penggunaan mesin Claude Code resmi.

## Implementasi 0.0.68

Auth Claude kini memakai Claude Agent SDK 0.3.307 beserta mesin native resmi
2.1.307 yang dikemas bersama aplikasi. Aplikasi tidak memerlukan proses atau
dashboard 9Router, maupun executable Claude yang terpasang secara global.

- Token OAuth tetap disimpan dengan secure storage Anticode, lalu diberikan
  hanya melalui environment proses anak. Refresh dikelola per akun Anticode.
- Preflight memeriksa subscription aktif dan Extra usage harus eksplisit off.
- Environment anak memakai allowlist: tidak mewarisi API key, base URL router,
  pengaturan Bedrock/Vertex/Foundry, atau konfigurasi Claude pengguna.
- Anticode menyebut identitasnya melalui `CLAUDE_AGENT_SDK_CLIENT_APP` resmi.
- Tool bawaan mesin dimatikan. Hanya schema tool Anticode yang tersedia lewat
  in-process MCP; eksekusi dan persetujuan tetap milik agent loop Anticode.
- Proses menunggu hasil tool nyata, melanjutkan konteks native selama run,
  lalu ditutup saat selesai/dibatalkan. Percakapan yang dipulihkan dikirim
  sebagai transkrip dengan role asli dan gambar asli; bukan instruksi user baru.
- Tidak ada fallback model, router, atau API berbayar. Model jawaban diperiksa
  terhadap model yang diminta. Label biaya SDK bukan tagihan akun.

## Batas bukti

Kedua model `claude-sonnet-5-5` dan `claude-opus-5-5` lulus probe nyata melalui
adapter mesin resmi: tool fixture diminta, hasilnya diterima, dan jawaban akhir
streaming keluar. Fixture tool hanya membaca nilai dalam memori; ini bukan
benchmark kemampuan coding atau bukti kuota tanpa batas. Status Extra usage
diperiksa sebelum probe, bukan diubah oleh pengujian.

Kedua model juga lulus uji gambar merah dan pembacaan ulang gambar dari riwayat.
Paket aplikasi nyata diuji dengan akun Claude terenkripsi yang disalin ke profil
terisolasi: masing-masing model membuat file melalui `apply_patch`, membacanya
kembali dengan `read_file`, dan menghasilkan jawaban streaming. Ini adalah smoke
test coding sederhana, bukan benchmark. Pemeriksaan profile/usage sempat mendapat
429; hasil sukses berikutnya tidak menghapus batas tersebut. Preflight sukses
dapat dipakai ulang maksimal 30 detik dalam run dan token yang sama.

`npm test`: 60 file / 617 tes lulus; typecheck dan build lulus. Smoke test paket
dan fixture login Claude lulus. Integrasi lima akun Cline melalui callback OAuth
fixture membuktikan 25 prompt dalam satu sesi/model dibagi 5 per akun, termasuk
restart. Ini bukan pengujian inference lima akun Cline nyata.

Pengujian unit memisahkan auth/refresh, bridge SDK, pemanggilan beberapa tool,
pembatalan, pemilihan model, isolasi environment, dan lokasi executable di luar
ASAR. Pengujian fixture auth tidak menjalankan CLI sungguhan dengan token palsu.

REA yang diminta ada di Downloads (`rea-main 2`), tetapi checkout tersebut belum
mempunyai compiled runtime/dependencies. Panduannya digunakan dengan runtime
REA yang sudah tersedia di cache lokal. Analisis chunk paket 9Router gagal
pada kompilasi helper ownership macOS karena konflik modul `SwiftBridging`.
Evidence parsial `ev_15c84398a1d4d281e4835ad5a74db15462803fd5bd855bb539f0ead0c83df61a`
tidak membuktikan analisis semantik lengkap. Digest inventori chunk:
`68843787a3250d0ad1e3d283681d618d746ff79c01fc89a74fa6b0f4f96fd59b`.
Temuan protokol di atas berasal dari pemeriksaan paket dan probe provider,
bukan klaim keberhasilan dekompilasi REA.

Sumber resmi: [Claude Code dengan Pro/Max](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan),
[Claude Agent SDK TypeScript](https://github.com/anthropics/claude-agent-sdk-typescript).

Diagnostik opsional `scripts/probe-claude-subscription.mjs` membandingkan HTTP
langsung dan router. `scripts/probe-claude-code.mjs` menguji adapter native.
Keduanya membaca akun 9Router yang sudah ada hanya untuk probe satu kali; ini
bukan dependensi aplikasi dan tidak menulis token ke laporan.
