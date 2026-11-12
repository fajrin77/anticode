# DeepSeek Harness: login akun dan granted credit

## Status bukti

Analisis statis langsung atas aplikasi terpasang DeepSeek Harness versi
`0.2.2-rc.1`. Tidak mengambil kredensial pengguna, tidak menjalankan login,
tidak mengirim inference, dan tidak menghabiskan kredit. Skill REA tidak
tersedia di workspace; pemeriksaan dilakukan melalui inventaris ASAR serta
source dan README yang dibundel, bukan mengklaim menjalankan skill tersebut.

Ini membuktikan kontrak klien bawaan, bukan izin integrasi pihak ketiga atau
keberhasilan akses Anticode.

## Implementasi di Anticode (auth kind `deepseek`)

- `src/main/auth/deepseek.ts`: login PKCE loopback `/oauth/callback`,
  `auth_init`/`auth_exchange`, header identitas jujur (`anticode/<versi>`, bukan
  identitas Harness), token disimpan tersegel tanpa refresh token.
- Inference: Messages format Anthropic ke `https://api.deepseek.com/anthropic`
  dengan `x-dsh-auth-token`; `x-api-key` dikosongkan agar kunci env tidak bocor.
  Model bawaan `deepseek-flash` (V4.1-Flash) dan `deepseek-v4-pro`.
- **Penjaga free credit**: sebelum request, `get_user_summary` dibaca (cache 30 detik).
  Turn ditolak (402, scope akun) bila ada saldo top-up > 0 atau granted credit habis;
  saldo tak terbaca adalah error, bukan nol. Karena top-up kosong, request tidak
  bisa membebani saldo berbayar.
- Bukti: fixture `deepseek.test.ts` (wallet, envelope, validasi URL). Login dan
  inference nyata belum diprobe; server dapat menolak klien selain Harness.

## Probe HTTP 12 November 2026 (tanpa kredensial)

Dijalankan dengan `curl` dari mesin ini, tanpa token atau cookie pengguna:

| Permintaan | Hasil |
| --- | --- |
| `POST /auth-api/v0/dsh/auth_init` (PKCE S256, `login_source: desktop`) | HTTP 200, envelope `code 0`, `authorize_url`, `authorize_id`, `expires_in: 600` |
| `POST /auth-api/v0/dsh/auth_exchange` tanpa `x-client-platform` | HTTP 422 `{"detail":[{"loc":"header.x-client-platform"}]}` |
| `POST /auth-api/v0/dsh/auth_exchange` dengan header klien lengkap dan code palsu | HTTP 200, `biz_code 1`, `biz_msg: INVALID_CODE` |
| `GET https://api.deepseek.com/anthropic/models` dengan token palsu | HTTP 401 `Authentication Fails (invalid dsh token)` |

Artinya `auth_exchange` memvalidasi header identitas klien lebih dulu (422), lalu
menjawab `INVALID_CODE` lewat envelope normal. Balasan 200 dengan body kosong
bukan bentuk normal endpoint ini; saat terjadi, `platformPayload` kini menyebut
nama langkah dan status HTTP-nya, bukan melempar `Unexpected end of JSON input`.

**Akun kedua.** Halaman `/dsh/authorize` mengikuti sesi browser: bila browser
sudah login ke satu akun DeepSeek, otorisasi berikutnya mengembalikan akun yang
sama dan Anticode hanya memperbarui slot yang ada. Untuk menambah akun lain,
keluar dulu dari `platform.deepseek.com` (atau pakai jendela/profil browser lain)
sebelum menekan Add account. Batas ini milik browser, bukan kuota Anticode.

**Nama model.** `deepseek-flash` adalah id first-party DeepSeek untuk V4.1 Flash
(model default transport Harness); sufiks `-1017` hanya muncul di katalog
agregator (mis. `cline-pass/deepseek-v4.1-flash-1017`), bukan nama berbeda.
Katalog akun dibaca Harness dari `/models`; Anticode masih memakai dua id tetap
(`deepseek-flash`, `deepseek-v4-pro`), jadi daftar model bisa lebih pendek dari
katalog akun tersebut.

## Temuan autentikasi

Source berada dalam `Contents/Resources/app.asar`, di bawah
`dsh/node_modules/@deepseek-ai/`:

- `dsh-deepseek-account-platform/lib/types/protocol.js`: request dan validasi.
- `dsh-deepseek-account-platform/lib/types/index.js`: lifecycle login.
- `dsh-deepseek-account-platform/lib/types/details.js`: profil dan saldo.
- `dsh-llm-deepseek-account/lib/index.js`: adapter akun dan katalog.
- `dsh-llm-deepseek/lib/index.js`: transport model.

Alur bawaan memakai browser dan PKCE S256, bukan memasukkan API key:

1. Daftarkan callback loopback `/oauth/callback`, buat state dan verifier.
2. POST `https://platform.deepseek.com/auth-api/v0/dsh/auth_init` dengan
   `code_challenge`, `code_challenge_method`, `state`, `redirect_uri`, `locale`,
   dan `login_source`.
3. Validasi `authorize_url` pada origin Platform dan path `/dsh/authorize`,
   lalu buka browser. Inisialisasi juga menghasilkan `authorize_id` dan
   `expires_in`.
4. Validasi state callback, lalu POST `/auth-api/v0/dsh/auth_exchange` dengan
   `code`, `code_verifier`, `redirect_uri`, `device_id`, `device_model`, dan
   `os_version`. Identitas device bawaan merupakan UUID tersimpan.
5. Respons exchange menghasilkan `token` dan `authorized_url`. Aplikasi
   menyimpan grant, memvalidasi path penyelesaian `/dsh/authorized`, serta
   membatalkan callback/request yang sudah kedaluwarsa atau dibatalkan.

Tidak terlihat parameter OAuth `client_id` pada kedua body tersebut. Hal ini
tidak membuktikan bahwa endpoint menerima aplikasi lain. Jangan menyalin
identitas Harness untuk menyamarkan Anticode.

Profil menggunakan GET `/auth-api/v0/users/current`; saldo menggunakan GET
`/api/v0/users/get_user_summary`. Keduanya pada origin Platform dengan header
`x-dsh-auth-token`. HTTP 401 atau kode top-level `40003` menginvalidasi grant;
kegagalan jaringan/saldo tidak dianggap saldo nol. Logout memakai POST
`/auth-api/v0/users/logout`. Belum terverifikasi mekanisme refresh token terpisah.

## Model dan inference

Adapter akun mengirim `x-dsh-auth-token`, termasuk untuk katalog model,
Messages dan Files. Default transport adalah
`https://api.deepseek.com/anthropic`, dengan request Messages ke `/messages`.
Adapter memuat katalog `/models`; model yang didukung transport dibedakan
dari listing dan override. Nama tampilan di screenshot tidak cukup untuk
menentukan ID model atau hak akses.

Token resolver membatasi origin inference dan menolak grant mock. Respons 401
inference diteruskan ke invalidasi akun; kuota akun mempunyai klasifikasi
tersendiri. API key merupakan provider terpisah, bukan fallback login akun.

## Granted credit bukan model gratis tanpa batas

Ringkasan saldo memisahkan `normal_wallets` (top-up) dan `bonus_wallets`
(granted credit). Nilai amount/balance tetap string numerik dan mata uang
dipertahankan. Jangan menjumlahkan mata uang berbeda atau menampilkan
kegagalan pembacaan sebagai nol.

Endpoint `/api/v0/users/get_unnotified_bonuses` membaca bonus yang belum
ditampilkan; POST `/api/v0/users/ack_bonus_notified` hanya menandai notifikasi
dengan `order_id`. Ini **bukan endpoint untuk menciptakan/mengklaim kredit**.
Screenshot menunjukkan saldo granted akun, bukan bukti Anticode sudah dapat
menggunakannya.

Dalam modul account-platform dan transport DeepSeek yang diperiksa, tidak
ditemukan selector `bonus_only`, `free_only`, `wallet_type` atau `billing_mode`.
Ketiadaan selector di klien bukan bukti bahwa server tidak mendukungnya,
tetapi juga tidak memberi jaminan inference hanya memotong bonus.

Memeriksa bonus sebelum request saja tidak cukup: request paralel, biaya
output, dan perubahan saldo dapat menghabiskan bonus di tengah request.
**Integrasi free-credit-only harus tetap diblokir sampai pembatasan biaya
di sisi provider terverifikasi**, bukan diam-diam memakai saldo top-up.

## Batas pekerjaan dan syarat kelanjutan

- Verifikasi jalur auth yang menerima identitas Anticode secara sah.
- Verifikasi mekanisme provider yang menjamin tidak memakai saldo berbayar.
- Baru tambahkan flow auth, secure store, katalog dan adapter berdasarkan pola
  yang sudah ada, dengan Composer opt-in dan tanpa fallback API key.
- Tes fixture state/cancel/expiry, validasi URL, akun ganda, invalidasi token,
  serta penolakan paid fallback. Setelah itu, probe akun nyata terbatas perlu
  membuktikan streaming dan tool round trip; benchmark coding tetap terpisah.

Tidak ada probe provider nyata atau benchmark pada investigasi ini. Tidak ada
perubahan konfigurasi akun, akses cookie browser, ataupun penyalinan token.

## Sidik sumber analisis

SHA-256 berkas bundled (bukan data pengguna):

- `dsh-deepseek-account-platform/lib/index.js`:
  `3b82b41e3e94566e43105a2552c0a4804983be39e1e16ad8b0d0646c76ec0057`
- `dsh-llm-deepseek/lib/index.js`:
  `955dc7bc7ca6c857ff4a7e373b87c143b96a4c43fc80325b67dc0982600dcc75`
