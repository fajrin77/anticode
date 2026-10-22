# OpenCode dan pola 9Router → router langganan mandiri Anticode

Analisis sumber dimulai 20 Oktober 2026; implementasi mandiri diperbarui 21 Oktober 2026. Target pengguna: ChatGPT, Claude, Clinepass; pemakaian paket bulanan, tanpa perpindahan otomatis ke API berbayar.

## Sumber dan batas bukti

- REA yang diberikan: `/Users/asani/Downloads/rea-main 2`, versi package 6.7.0. Panduan `.agents/skills/reverse-engineer-anything/SKILL.md` membedakan analisis artifact dari analisis repository sumber. Dokumen lampiran dipakai sebagai referensi teknis; isinya bukan permintaan pengguna untuk memasang engine, mengubah konfigurasi Codex, atau menjalankan aplikasi target.
- CLI REA 6.7.0 dijalankan melalui npx terhadap `/Applications/OpenCode.app/Contents/Resources/app.asar`. Percobaan awal menolak integrity mismatch pada native node-pty. Percobaan kedua dengan `--integrity-policy record-and-continue` mempertahankan perbedaan itu sebagai data tak terverifikasi. Inventory menjumpai 6.695 file; parser kemudian gagal saat helper kepemilikan proses macOS dikompilasi: duplikasi modul SwiftBridging di Command Line Tools. Ini bukan bukti bahwa aplikasi berbahaya; penyebab perubahan native binary belum dipastikan. Compiler OS tidak diubah.
- Identitas artifact dan error tersimpan di [opencode-rea-summary.json](opencode-rea-summary.json). Analisis REA tidak selesai; temuan arsitektur di bawah berasal dari sumber, bukan pengamatan runtime aplikasi terpasang.
- OpenCode: commit `133b1ebfafc3ae040b9b23ff3fcad49e273c9cf9`, [repository resmi](https://github.com/anomalyco/opencode/tree/133b1ebfafc3ae040b9b23ff3fcad49e273c9cf9). Checkout lokal: `/tmp/anticode-opencode-reference`. Snapshot sumber ini tidak dibuktikan sama dengan build desktop yang terpasang.
- 9Router: commit `87a74e1bda3677193c6f71a7e2100c90311f0689`, [repository resmi](https://github.com/decolua/9router/tree/87a74e1bda3677193c6f71a7e2100c90311f0689). Checkout lokal: `/tmp/anticode-9router-reference`.
- Implementasi Anticode ditulis untuk kontrak tool, checkpoint, workspace, dan adapter yang sudah ada. Tidak menyalin seluruh runtime atau dependensi kedua proyek. Keduanya berlisensi MIT pada snapshot yang dibaca; penyalinan substansial pada pengembangan berikutnya harus mempertahankan notice lisensinya.

## Cara kerja OpenCode yang teramati di sumber

Alur utamanya: sesi → pemilihan model/provider → penyusunan prompt dan tools melalui hook → serialisasi protokol → stream jawaban → validasi/persetujuan/eksekusi tool → hasil dikembalikan ke model → ulang sampai selesai. OAuth adalah lapisan autentikasi provider, bukan mesin agent atau mekanisme pengubahan harga API.

| Keluarga model | Perilaku sumber OpenCode | Penerapan Anticode |
| --- | --- | --- |
| GPT coding modern | `packages/core/src/tool/plugin/patch.ts` menghapus edit/write dan mempertahankan patch untuk model `gpt-`, dengan pengecualian GPT-4 dan OSS | GPT generasi 5+ dan Codex menerima `apply_patch`; edit/write/delete teks digabung ke tool ini |
| Claude | `packages/core/src/plugin/optimize.ts` menambahkan panduan Anthropic; patch dihapus oleh hook patch | Tetap memakai `edit_file`, `write_file`, `delete_file`; transport Anthropic tetap milik adapter |
| Kimi / Trinity / Muse | `optimize.ts` mempunyai template prompt tersendiri; Muse mengisi nama model | Memakai tool edit/write Anticode yang sama; tidak mengklaim menyalin seluruh template khusus |
| Model lain | Prompt umum dan kemampuan tool sesuai registry/protokol | Mempertahankan kontrak tool umum dan validasi schema |

`packages/core/src/session/system-prompt.ts` menyusun petunjuk berdasarkan tool yang benar-benar tersedia. Plugin optimisasi yang menghapus grep/glob ditandai **disabled** di sumber: jangan menyimpulkan semua GPT harus kehilangan tool pencarian. `packages/ai/src/route/client.ts` dan `protocols/utils/tool-schema.ts` memproyeksikan schema sesuai model; format wire tetap berbeda antar-provider.

Anticode mempertahankan pencarian, terminal, approval, checkpoint, compaction, dan pembatasan workspace. Tool patch mendukung Add/Update/Delete, beberapa file dan hunk, pencocokan konteks unik, preview, CRLF, dan Revert. Move tidak didukung; tool menjelaskan batas itu kepada model. Semua hunk divalidasi sebelum penulisan; pemulihan saat error bersifat best effort, bukan transaksi filesystem atomik.

## Ringan pada request coding

`SessionToolCatalog` memuat core coding, pencarian web, dan `load_tools` lebih dulu. Kelompok `documents`, `browser`, `media`, dan `integrations` dimuat hanya saat diminta. Kelompok yang sudah dipakai dipulihkan dari riwayat sesi. MCP tetap dibaca secara dinamis dan sub-agent tetap memakai kit terbatas yang diberikan kepadanya.

Pengukuran schema JSON UTF-8 dari registry bawaan tanpa MCP eksternal:

| Request awal | Jumlah tool | Byte schema |
| --- | ---: | ---: |
| Registry penuh sebelumnya | 32 | 17.380 |
| Core + load_tools | 15 | 9.155 |
| GPT coding + apply_patch | 13 | 8.247 |

Schema awal turun sekitar 47% (umum) atau 53% (GPT). Ini **pengukuran byte schema**, bukan pengukuran token tokenizer, latensi inference, atau RAM Electron. Pemanggilan `load_tools` menambahkan satu langkah ketika fitur tambahan dibutuhkan. Setelah dimuat, kelompok tetap tersedia sepanjang sesi.

## Implementasi mandiri di Anticode

Koreksi ruang lingkup: **9Router adalah referensi arsitektur, bukan layanan yang harus dijalankan**. Provider proxy 9Router, konfigurasi port 20128, allowlist namespace `cx/…`, dan petunjuk menjalankan dashboard eksternal dari implementasi awal sudah dihapus dari jalur produksi. Tidak menambahkan dependency package 9Router, daemon, atau server proxy.

Alur sekarang: UI Anticode → pemilihan akun/model di `runtime.ts` → adapter langsung provider → stream → tool Anticode → pencatatan usage. Router memakai fondasi rotasi Anticode dan menambahkan filter entitlement paket, batas akun, cooldown, reset yang diketahui, serta penghentian ketika semua rute tidak tersedia.

| Komponen | Pemilik di Anticode |
| --- | --- |
| Browser OAuth, callback dan PKCE | `src/main/auth/` |
| Penyimpanan terenkripsi dan multi-akun | `auth/store.ts` |
| Satu refresh grant per akun saat beberapa sesi/Renew bersamaan | `auth/provider.ts`, `ensureFreshAuthTokens` |
| Daftar model akun langsung, cache setelah restart, fallback offline | `auth/catalogue.ts` |
| Seleksi model/akun dan fallback | `runtime.ts`, `subscriptions.ts`, `rotation.ts` |
| Metadata error kuota dan waktu reset | `providers/requestError.ts`, `providers/codex.ts` |
| Pembacaan quota ChatGPT | `subscriptionQuotas.ts` |
| Panel aktivasi dan koneksi paket | Settings → Auth provider |

Daftar model yang pernah diamati disimpan sebagai metadata publik, terpisah dari token. Saat offline, daftar terakhir dipakai; bila belum ada, dipakai fallback bawaan. Tidak mengklaim daftar cache sebagai entitlement terkini. Cache dibersihkan bila akun dihapus atau login baru menggunakan ulang id akun.

## Jalur akun dan biaya

| Akun | Jalur langsung | Batas |
| --- | --- | --- |
| ChatGPT/Codex | Login OAuth bawaan Anticode; request Responses langsung ke `chatgpt.com`, bukan melalui 9Router | Model dan akses ditentukan paket akun. Kuota account-wide memblokir model-model lain akun yang sama sampai reset/cooldown |
| Clinepass | Masukkan key paket di panel Auth provider; endpoint langsung `https://api.cline.bot/api/v1` | Cline extension OAuth bukan pengganti key paket Clinepass. Endpoint kustom/proxy tidak diklasifikasikan sebagai rute paket mandiri |
| Claude | Adapter OAuth lokal yang sebelumnya ada tetap dipertahankan | Tidak dimasukkan ke routing paket terjamin. Implementasi mandiri tidak mengubah kebijakan provider mengenai pemakaian Pro/Max oleh harness pihak ketiga |

Rujukan resmi: [OpenAI — integrasi ChatGPT plan](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), [Claude — autentikasi dan third-party tools](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account). Implementasi adapter lama yang menggunakan client OAuth provider tidak sama dengan registrasi atau persetujuan client ID Anticode sendiri; perubahan ini tidak mengklaim sertifikasi provider.

Mode **Subscription routing** menambahkan model akun yang tersedia ke pool tanpa menghapus konfigurasi provider lain. Hanya adapter yang diklasifikasikan sebagai paket langsung dan model dalam katalog akun boleh dipilih otomatis. Grup/model dapat disesuaikan di Settings → Models. Akun atau model baru setelah aktivasi dapat ditambahkan dari sana; mengaktifkan ulang mode juga memperbarui pool dari akun yang tersedia.

Fallback dalam mode ini tidak menuju provider API berbayar. Kuota yang diketahui habis diterapkan ke seluruh model akun, dengan reset provider yang dipersistenkan. Bila reset tidak diketahui, Anticode tidak mengarang tanggal reset; pengguna dapat mencoba lagi setelah meninjau kuota dan memakai Reset counts. Cooldown akun mencegah perpindahan semu ke model lain pada akun yang sama. Ketika seluruh rute habis, permintaan berhenti. Balasan yang sudah mengalir tidak diputar ulang ke akun lain.

Pengaturan extra usage/overage milik provider tetap berlaku. Anticode tidak membeli kredit, tidak membeli reset, dan tidak mengaktifkan extra usage. Matikan extra usage di portal provider bila ingin tetap di dalam kuota paket. OAuth atau key paket tidak membuktikan semua model gratis/unlimited.

## Usage dan quota

Usage → **This month** menyaring token yang dilaporkan provider dalam bulan kalender lokal. Pemakaian paket tidak dikonversi menjadi harga API per-token. Jika seluruh biaya tidak diketahui, UI menampilkan tanda kosong, bukan menganggapnya nol dolar.

Panel **Refresh ChatGPT quota** membaca jendela pemakaian akun langsung. Persentase yang tidak dilaporkan tetap `unknown`; reset yang tidak diketahui tidak ditebak. Pembacaan kuota bersifat manual, read-only, dan dibatasi timeout. Angka tersebut terpisah dari catatan token lokal, dapat memiliki jendela jam/minggu, dan tidak mengubah tanggal reset provider menjadi bulanan. Sisa kuota Clinepass belum memiliki adapter pembacaan langsung dan disebutkan jelas di UI.

## Cara memakai

1. Jalankan build Anticode terbaru dari proyek ini.
2. Buka **Settings → Auth provider**. Login ChatGPT dengan tombol Sign in. Untuk Clinepass, masukkan **key paket Clinepass** pada form yang tersedia.
3. Aktifkan **Subscription routing**. Anticode mengambil daftar model akun, menambahkan rute langsung ke pool, dan memilih akun/model secara internal.
4. Sesuaikan model/grup di **Settings → Models**. Lihat token lokal pada **Usage → This month**, dan gunakan **Refresh ChatGPT quota** untuk jendela kuota akun.

Tidak perlu menginstal, menjalankan, atau menghubungkan Anticode ke 9Router.

## Verifikasi

Tes mencakup seleksi berdasarkan entitlement adapter, penolakan fallback ke provider berbayar, cooldown lintas model satu akun, persistensi/reset kuota, satu refresh grant untuk sesi serentak dan Renew, katalog model per akun, parsing stream selesai/gagal/terputus, serta seluruh regresi tool OpenCode dari perubahan sebelumnya.

`node scripts/verify-native-subscriptions.mjs` menjalankan Electron dengan profil sementara dan respons provider tiruan. Uji mengaktifkan mode lewat UI, membaca quota, membuat akun pertama mendapat error kuota, memindahkan request ke akun kedua, menjalankan `apply_patch`, memeriksa file di workspace, dan memastikan usage tercatat tanpa biaya API. Semua request model yang diamati menuju URL provider langsung. Uji restart memeriksa bahwa mode dan katalog model yang berbeda dari fallback bawaan tetap tersedia.

Tidak ada login akun nyata, konsumsi paket asli, atau panggilan API berbayar yang dilakukan dalam pengujian. Tidak membuat installer/release. Perubahan auth lokal yang sudah ada dipertahankan dan digabung dengan refresh coordinator; tidak mengklaim alur provider nyata sudah terverifikasi.

## Validasi akhir dan pembaruan lokal — 21 Oktober 2026

- `npm test`: 51 file, 463 tes lulus.
- Build dan typecheck lulus; uji Electron routing langsung serta restart lulus.
- UI Auth provider diringkas menjadi toggle routing, koneksi Clinepass, kuota, dan baris akun. Detail tambahan dipindahkan ke tooltip.
- Versi lokal dinaikkan menjadi **0.0.53**, paket macOS arm64 dibuat dan dipasang di `/Applications/anticode.app`. Versi 0.0.52 disimpan sebagai backup bundle; profil akun dan percakapan tidak diganti.
- Smoke test paket serta pemeriksaan UI ringkas pada aplikasi terpasang lulus. Tidak menerbitkan release publik.

## Perbaikan login dan katalog — 0.0.54

- Cline browser callback dapat tidak mengembalikan `state`. Login sekarang mengikat callback ke path acak per percobaan, tetap menolak state eksplisit yang salah, dan menerima bundle token callback SDK tanpa menukarkannya lagi. Request chat OAuth memakai `/api/v1/chat/completions` dan prefix `workos:` untuk JWT WorkOS. Uji callback/token/transport lulus; login interaktif akun Cline nyata belum diuji.
- Katalog Codex memakai client version `0.163.0`, menggabungkan model baseline dengan katalog akun, dan picker akun menampilkan katalog di luar pool rotasi. Baseline delapan model sesuai sumber Codex: GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, GPT-5.6 Sol/Terra/Luna, GPT-5.5. Akses aktual tetap diputuskan provider.
- Muse Clinepass sebelumnya tersimpan sebagai `cline-pass/Muse-Spark-1.3-contributor`. ID ini benar-benar menghasilkan HTTP 404. ID lowercase `cline-pass/muse-spark-1.3-contributor` menghasilkan HTTP 200 dan jawaban `OK`. Normalisasi diterapkan ke katalog, request sesi lama, serta pool/grup dan kunci usage; tally tetap dipertahankan.
- Uji nyata adapter Muse menjalankan satu tool tiruan `check_value`, mengirim hasil tool, lalu menerima `OK`: dua request, 1.228 input token dan 197 output token yang dilaporkan provider. Tidak mengeksekusi tool filesystem. Ini memakai sedikit usage paket nyata; klaim tanpa usage di bagian sebelumnya hanya merujuk pengujian fixture sebelumnya.
- `npm test`: 51 file, 470 tes lulus; build/typecheck lulus.

Sumber implementasi: [Cline SDK auth](https://github.com/cline/cline/blob/main/sdk/packages/core/src/auth/cline.ts), [Codex models](https://github.com/openai/codex/blob/main/codex-rs/core/models.json), [Clinepass model compatibility](https://github.com/jellydn/pi-clinepass-provider/blob/main/src/models.ts).

Paket 0.0.54 lulus smoke test profil kosong dan uji Electron routing/picker/restart. Dipasang di `/Applications/anticode.app`, aplikasi dibuka ulang; backup bundle sebelumnya: `/Users/asani/Library/Application Support/anticode-build-backups/anticode-0.0.53-d916c880.app`. Profil akun dan percakapan dipertahankan. Tidak menerbitkan release publik.

## Cline gratis dan penghentian loop — 0.0.55

Modul yang diminta: `/Users/asani/Downloads/rea-main 2/.agents/skills/reverse-engineer-anything/SKILL.md`. Source Anticode tersedia lengkap, sehingga sesuai petunjuk skill, diagnosis memakai inspeksi source, bukti runtime dan regresi melalui Electron; tidak mengulangi setup REA atau mengklaim dekompilasi baru.

Bukti dan batasnya:

- **R1 — transcript lokal:** percakapan dengan model Clinepass berulang pada `browser_get_text`, screenshot, `todo_write`, network log, lalu membaca teks yang sama. Ada prompt internal yang memaksa kelanjutan checklist ketika akses edit belum tersedia. SHA-256 snapshot `sessions.json` saat diperiksa: `4cac7d73c8d8501b0a05242b160de2667f3e7c8700f461278a57dda70d8f0b8d`. Tidak menyalin URL Drive atau isi laporan pengguna ke dokumen ini.
- **R2 — source:** deteksi lama hanya membandingkan putaran tool berturut-turut. Deteksi baru menghitung input + hasil identik di jendela 12 putaran, mengabaikan ID call dan urutan key JSON. Perubahan file aktual dan instruksi baru mengawali pengamatan baru; polling dengan hasil berubah tetap diizinkan. Continue mempertahankan penghalang loop setelah reload, sedangkan informasi/perintah baru bisa memulai pekerjaan lagi.
- **R3 — checklist:** status `blocked` diterima tool dan ditampilkan UI. Item blocked menghentikan pemaksaan lanjut. Prompt kelanjutan tanpa pekerjaan konkret dibatasi dua kali; plan mode juga tidak dipaksa mengeksekusi checklist. Ini membatasi pola yang direproduksi, bukan jaminan bahwa semua model akan selalu bertindak sempurna.
- **R4 — jalur runtime:** `scripts/verify-agent-loop.mjs` melewati IPC, runtime, agent, tool filesystem dan transport SSE sebenarnya dengan provider fixture. Siklus read/list berhenti setelah lima request model; Continue mengirim **nol** request tambahan. Tes modul juga mencakup restore/reload, instruksi baru, checklist blocked, serta polling yang benar-benar berubah.
- **R5 — katalog:** `/api/v1/models` menyediakan alias `:free` dan `openrouter/free`; `/api/v1/ai/cline/recommended-models` menyediakan tier `free[]` terpisah dari `clinePass`. Akun OAuth Cline sekarang hanya menawarkan rute gratis. Model berbayar dari snapshot/sesi lama ditolak sebelum request; tidak ada substitusi ke versi berbayar. Katalog Clinepass paket tetap terpisah. UI menandai pilihan akun Cline dengan `free`.
- **R6 — uji nyata:** 26 ID gratis diuji dengan prompt singkat dan batas 128 output token: 21 respons HTTP 200, 5 respons HTTP 403 khusus Cline resmi. Hanya 13 dari 26 probe awal menghasilkan teks terlihat; HTTP 200 saja tidak dianggap bukti model berhasil menjawab. [Ringkasan per model](./cline-free-probe-2026-10-21.json). Probe LFM tambahan dengan 512 output token menjawab OK; Gemma 31B mengirim error upstream 429 di dalam SSE HTTP 200.
- **R7 — error stream:** adapter meneruskan status upstream dari error `stream_initialization_failed` agar rate limit bisa ditangani router. Stream tanpa teks/tool tidak lagi dinyatakan sukses kosong. Model yang mendapat penolakan khusus aplikasi Cline disimpan sebagai tidak tersedia selama 15 menit, juga setelah refresh/restart, sehingga tidak terus dicoba oleh Continue/routing.

**Batas yang belum bisa dipenuhi:** `cline-free/muse-spark-1.3-contributor`, `cline-free/mimo-v2.6-flash`, `cline-free/minimax-m3.1-flash`, `cline-free/nemotron-3.5-super-vl`, dan `cline-free/solar-mini4` ditolak provider karena hanya diizinkan pada aplikasi Cline resmi. Anticode tidak mengaku sebagai aplikasi Cline, tidak melewati pembatasan tersebut, dan tidak menggantinya dengan rute berbayar. Rate limit/capacity upstream untuk rute gratis lain tetap milik provider. Semua model gratis belum dapat dinyatakan berfungsi.

Validasi: 51 file / **482 tes lulus**, build/typecheck lulus; UI katalog Cline gratis dan routing native lulus uji profil terisolasi. Uji routing ChatGPT, fallback kuota, tool patch, picker dan restart tetap lulus.

Sumber primer: [Cline recommendation service](https://github.com/cline/cline/blob/main/sdk/packages/core/src/services/llms/cline-recommended-models.ts), [bundled recommendations](https://github.com/cline/cline/blob/main/sdk/packages/llms/src/catalog/cline-recommended.generated.ts), endpoint Cline langsung yang disebut di atas. Hasil fixture tidak diklaim sebagai bukti akses provider nyata.

Paket 0.0.55 lulus smoke test profil kosong dan dipasang di `/Applications/anticode.app`; aplikasi dibuka ulang. Backup bundle sebelumnya: `/Users/asani/Library/Application Support/anticode-build-backups/anticode-0.0.54-4459b1d2.app`. Metadata katalog akun Cline yang diuji diperbarui ke daftar free, dengan cooldown untuk lima penolakan provider yang sudah diamati. Token akun serta percakapan dipertahankan. Tidak menerbitkan release publik.

## Uji ulang Muse free dan Laguna XS — 0.0.56, 21 Oktober 2026

Menggunakan kembali skill REA di Downloads, dengan source yang tersedia dan uji runtime terbatas. Bukti baru memperjelas diagnosis 0.0.55: HTTP 403 langsung tidak cukup untuk menyimpulkan bahwa promosi Muse masih aktif pada aplikasi resmi.

- **M1, API langsung:** `cline-free/muse-spark-1.3-contributor` masih mendapat HTTP 403 khusus Cline product surfaces. Tidak mengubah identitas request menjadi aplikasi lain.
- **M2, Cline resmi:** Cline CLI **3.0.73** dijalankan dari paket resmi dalam cache npm, memakai akun CLI yang sudah tersimpan. Probe sekali dengan provider `cline`, model free persis, working directory sementara, auto-approve false, retries 0, timeout 45 detik, dan prompt hanya meminta `OK` tanpa tool. Hasil exit 1: `model not found` dan pesan CLI **“Free model promotion ended”**. Tidak memanggil versi berbayar, mengeksekusi tool kerja, atau mengganti akun Anticode. Probe tidak membuktikan semua provider Muse telah berhenti; hanya jalur resmi yang diuji.
- **M3, OpenCode:** daftar live `https://opencode.ai/zen/v1/models` tidak memuat `muse-spark-1.3-contributor-free`. POST singkat ke endpoint publik Responses dengan ID free tersebut mendapat **HTTP 410**, tipe **ModelDeprecated**. Dokumentasi lama yang masih terindeks bukan bukti ketersediaan saat ini. Tidak meminta model Muse berbayar sebagai pengganti.
- **L1, Laguna:** uji ulang `poolside/laguna-xs-2.1:free` melalui akun Cline menghasilkan **HTTP 200, jawaban OK**, tanpa error stream. Ini mendukung bahwa error screenshot bersifat sementara di upstream, bukan bukti ID model salah.
- **L2, penanganan error:** normalisasi SSE Cline kini mengenali outer 404 yang memuat riwayat upstream 429 dan bukti rate limit eksplisit sebagai 429 dengan scope model. Pesan UI ringkas, tanpa JSON/ID organisasi/tautan penambahan key. 404 sebenarnya dan pembatasan 403 tetap dipertahankan. Pemeriksaan error dibatasi ukuran, kedalaman, dan jumlah node.
- **K1, katalog:** snapshot free yang berhasil diperbarui kini menjadi sumber utama. Fallback offline tidak lagi memasukkan Muse/MiMo promosi yang sudah tidak tercantum. Sesi lama yang memilih free ID tidak tersedia mendapat penjelasan katalog, bukan pesan menyesatkan bahwa ID tersebut model berbayar. Katalog paket Clinepass tetap terpisah.

Validasi: **51 file / 488 tes lulus**, build/typecheck lulus. Regresi SSE mencakup bentuk error screenshot, kedua adapter Cline/Clinepass, 404 asli, serta 403 yang tidak boleh diperlakukan sebagai rate limit. Batas tersisa: Muse free belum dapat disediakan di Anticode melalui dua jalur gratis resmi yang diuji; tidak mengklaim ada koneksi free yang berhasil.

Sumber primer: [Cline CLI](https://github.com/cline/cline/blob/main/apps/cli/README.md), [model OpenCode terkini](https://opencode.ai/v2/docs/console/models/), serta respons endpoint langsung di atas. Tidak mengulang setup REA yang sebelumnya tidak relevan terhadap diagnosis source ini.

Paket 0.0.56 lulus smoke test, uji UI Cline free, dan uji loop/Continue melalui Electron. Dipasang di `/Applications/anticode.app`; backup bundle: `/Users/asani/Library/Application Support/anticode-build-backups/anticode-0.0.55-00e88790.app`. Aplikasi dibuka ulang. Akun dan percakapan dipertahankan; model default CLI yang berubah saat probe dipulihkan ke nilai yang diamati sebelumnya. Tidak menerbitkan release publik.

## Beberapa akun per Auth provider — 0.0.57

- Tombol vendor berubah menjadi **Add account** setelah login pertama, dengan jumlah akun tetap terlihat. Saat menambah akun, petunjuk singkat mengingatkan pemilihan akun berbeda di browser.
- Login ChatGPT/Cline/Claude/CodeBuddy menyimpan setiap identitas secara terpisah, dengan ID stabil dan token tersegel masing-masing. Login ulang identitas yang sama memperbarui token akun tersebut dan mempertahankan nama kustom, bukan membuat slot quota tambahan. ChatGPT account ID yang berbeda tetap dipisahkan meskipun email sama.
- Saat native routing aktif, akun baru yang eligible masuk pool tanpa menghapus akun, usage, atau kelompok yang sudah disusun. Login ulang tidak menambahkan ulang semua model ke pilihan model yang telah dikurasi. Keanggotaan grup yang dipilih pengguna tetap berlaku.
- Ranking akun OAuth memakai jumlah usage semua model akun, sehingga akun yang memiliki lebih banyak model tidak mendapat giliran tambahan hanya karena ada model baru yang belum dipakai. Hitungan sesi aktif juga dihitung per akun. Model OAuth baru memulai tally nyata dari nol; tidak menambahkan usage sintetis ke akun.
- Batas/provider entitlement tetap berlaku: native routing memakai akun ChatGPT dan rute Cline gratis yang eligible. Penambahan beberapa akun tidak mengubah kebijakan kuota provider, dan kegagalan setelah teks mulai mengalir tetap tidak diputar ulang.

Validasi: **52 file / 495 tes lulus**, build/typecheck lulus. `scripts/verify-multiple-accounts.mjs` memakai respons vendor tiruan tetapi menjalankan callback OAuth localhost, IPC, penyimpanan OS, routing dan UI Electron sebenarnya: menambah dua akun ChatGPT + dua Cline, login ulang satu akun tanpa slot tambahan, lalu restart dengan empat akun tetap terbaca. Empat prompt lewat transport Responses dibagi dua request ke setiap akun ChatGPT. Tes modul mencakup identitas empat vendor, token/nama terpisah, account ID ChatGPT berbeda, total usage per akun, serta auto-enroll akun baru. Regresi quota fallback dan restart native juga lulus. Tidak login akun manusia baru atau mengonsumsi usage provider nyata untuk pengujian ini.

Paket 0.0.57 lulus smoke test dan dipasang di `/Applications/anticode.app`. Backup sebelumnya: `/Users/asani/Library/Application Support/anticode-build-backups/anticode-0.0.56-4823ecf4.app`. Aplikasi dibuka ulang; akun dan percakapan asli dipertahankan. Tidak menerbitkan release publik.


## 0.0.58 — public free routes and image compatibility (2026-10-21)

The screenshot at 10:32 shows product-surface 403 errors on `cline-free/minimax-m3.1-flash` and `cline-free/nemotron-3.5-super-vl`, plus a distinct 404 on Laguna XS because the conversation contains image input. The public free aliases are separate routes: a successful promotion catalogue entry does not prove third-party inference access.

- Prefer `minimax/minimax-m3.1-flash:free` and `nvidia/nemotron-3.5-super-vl:free` over their `cline-free/` equivalents only when the account advertises the public free route. Deduplicate the picker and resolve saved promotion selections at provider construction, including previously restricted selections. Never substitute a paid route or invent a Muse alias.
- Detect Laguna S/XS 2.1 as text-only in the existing composer warning and reject image-bearing requests (including previous conversation turns) before network I/O. Keep image content intact and explain that the user needs a vision model or a text-only conversation.
- Live probes using the stored Cline account and Anticode identity: both public free aliases returned HTTP 200 with actual streamed text, no stream error and no product restriction. Super VL also answered `Green` for a generated green PNG with a 512-token ceiling. A first 128-token image probe produced no visible text; HTTP 200 alone was not accepted as success.
- Regression coverage: old restricted promotion sessions send the advertised public free model; picker catalogue deduplicates equivalents; Laguna image history followed by Continue fails locally with a readable compatibility message. 52 test files / 499 tests passed, TypeScript and production build passed, Electron Cline picker test and packaged smoke test passed. One browser test timed out under simultaneous app/probe launches, then passed alone and in the complete rerun with four workers.


## User direction — reusable subscription integrations (2026-10-21)

The user confirmed 0.0.58 works and wants future subscription integrations to follow the successful Cline approach. This is a direction for future provider work, not evidence that every provider supports external subscription access.

- Integrate directly inside Anticode without a required external router. Use the account subscription or an explicitly free route; never silently fall back to a paid API route.
- Discover models available to the signed-in account. Distinguish similarly named public free, subscription, and official-app-only routes. Prefer an equivalent public free route only when advertised by the account catalogue; never infer access from the display name or spoof an official client to override a denied route.
- Support multiple distinct accounts, account-specific token renewal, quota/cooldown state and usage distribution. Reconnecting the same identity updates its credentials rather than manufacturing an extra quota slot.
- Validate text, images, streaming and tool calling separately. Include prior conversation images when checking model compatibility. A text greeting or HTTP 200 alone does not prove coding/tool reliability.
- Before claiming an integration works, verify actual streamed output through the Anticode adapter, meaningful tool execution and completion, supported image handling where applicable, and bounded behavior on denied access, exhausted usage and repeated Continue. Add regression coverage for confirmed bugs and verify the packaged app.
- Keep settings concise and explain actionable access/capability failures. Clearly distinguish provider-reported account quota from Anticode's local monthly token log. Do not promise unlimited monthly usage or universal provider support.


## 0.0.59 — composer opt-in, account sharing and provider key pools

Implemented provider/account Composer switches with persisted explicit opt-ins, one-time default-only migration and a meaningful empty picker. Account model lists now respect Settings → Models. Auth services are grouped visually without merging credentials or identities; manual selection of one model balances across same-service accounts using local monthly usage, busy state and known cooldowns. New accounts inherit compatible curated models. Usage records are separate from provider quota.

Custom API providers and Clinepass accept additional encrypted API keys under one provider/model list, with deduplication, key counts, local usage balancing and bounded pre-output failover. Key health records contain hashes, not keys. Existing image generation stays on the primary key. UI/IPC/Electron fixtures verified adding a second key, four requests split two per key, encrypted-at-rest values and restart persistence. Cline fixture verified four same-model prompts alternating across two accounts with model rotation disabled.

Prepared OpenCode Go plan-key connection with documented Go-only protocol routes, own user agent, stable conversation header, secret input and Extra usage hint. Prepared standard Responses adapter and routed Anthropic/Google through existing adapters. All four protocol tool round trips use fixture network responses. CodeBuddy login polling and refresh were updated from official CLI 2.171.0; account identity supports deduplication. No real subscription credentials were available for Go/CodeBuddy; direct unauthenticated Go model endpoint probe returned HTTP 403 and proves no entitlement. CodeBuddy billing remains unknown; it is not silently classified as a verified subscription. No package was purchased or public release published.
