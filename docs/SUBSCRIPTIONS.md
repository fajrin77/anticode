# Panduan integrasi subscription

Pembaruan 0.0.71: pemeriksaan Claude dibagi oleh inference, katalog, dan Usage
berdasarkan hash token, dengan satu request bersama dan cache 5 menit. Bukti
subscription aktif + Extra usage OFF yang terverifikasi dapat dipakai sampai
maksimum 15 menit ketika endpoint pemeriksaan mendapat 429/5xx. Waktu bukti asli
tidak diperpanjang oleh kegagalan. Token baru, penolakan 401/403, Extra usage ON,
atau bukti yang kedaluwarsa tetap memblokir inference. Token/API key berbayar dan
endpoint alternatif tetap tidak dimuat ke mesin Claude. Retry-After pemeriksaan
dihormati; gagal membaca kuota tidak dianggap kuota inference habis.

Gangguan transport tanpa HTTP tidak memberi cooldown akun. Rate limit inference,
kuota nyata, dan autentikasi tetap ditangani sesuai cakupannya. Stream yang putus
mendapat maksimum dua kelanjutan otomatis dengan riwayat parsial serta hasil tool
yang sudah dikonfirmasi; tool yang telah dieksekusi tidak direplay oleh transport.
Pengulangan tanpa bukti baru mendapat satu arahan pemulihan sebelum dihentikan;
Continue dapat memilih tindakan berbeda tanpa terkunci oleh penolakan lama.

Pembaruan UI 0.0.69: batas kuota resmi Claude/ChatGPT ditampilkan di Usage per
akun, dengan persentase terpakai dan waktu reset. Pembacaan digabung/cache
60 detik; kegagalan refresh mempertahankan angka terakhir dengan status data
lama. Layanan tanpa adapter kuota tampil sebagai belum tersedia, bukan 0%.
Angka ini terpisah dari catatan token dan biaya lokal.

Pembaruan 0.0.70: ClinePass mempunyai jenis Auth tersendiri (`clinepass`), terpisah
dari `cline` yang kini diberi label Cline Free. Login browser ClinePass memakai
identitas Cline, memeriksa subscription aktif dan entitlement `cline_pass`, lalu
membaca `/api/v1/users/me/plan/usage-limits`. Payload `data.limits[]` berisi
`type`, `percentUsed`, dan `resetsAt`; UI menampilkan jendela five_hour, weekly,
monthly tanpa mengarang nilai kosong. Data dicache 60 detik dan dipertahankan
sebagai data lama saat refresh gagal. Cline Free tetap terbatas ke model gratis.

Koneksi ClinePass lama pada endpoint langsung dipindahkan sekali dari konfigurasi
custom ke secure Auth store. ID `clinepass` dipertahankan untuk sesi lama, usage,
Composer dan rotation; akun baru memakai `auth:clinepass`. Beberapa key lama
dipertahankan sebagai slot terpisah, tanpa mengasumsikan tambahan kuota. Source
baru dihapus setelah destination terenkripsi diverifikasi di disk. Gateway custom
pada host lain tidak diubah. Login browser membandingkan identitas subscription
untuk menautkan key lama dan mencegah slot akun duplikat. Tidak ada fallback ke
Cline usage-billing. Profil baru tidak memperoleh akun, key atau koneksi aktif bawaan.

Pembaruan Claude 22 Oktober 2026: lihat [mesin Claude Code resmi](research/claude-code-native-2026-10-22.md).
Sejak 0.0.68, Auth Claude memakai mesin resmi yang dibundel, bukan adapter HTTP
OAuth pihak ketiga yang dibahas pada catatan historis di bawah. Subscription
aktif dan Extra usage off tetap diperiksa sebelum inference. Environment tidak
memuat key API atau endpoint alternatif; tool tetap dijalankan oleh Anticode.

Panduan ini menjadi acuan pengembangan integrasi akun di Anticode. Dasarnya adalah hasil
integrasi Cline yang dikonfirmasi pengguna pada 21 Oktober 2026. Ini bukan jaminan bahwa
semua provider mengizinkan akses subscription dari aplikasi lain.

## Prinsip

- Koneksi dan routing berjalan langsung di Anticode tanpa layanan router eksternal wajib.
- Gunakan kuota subscription atau rute gratis yang tersedia untuk akun. Jangan mengganti
  kegagalan akses dengan rute API berbayar secara otomatis.
- Ambil katalog akun ketika tersedia. Bedakan nama model, ID rute, dan hak akses sebenarnya.
  Model yang muncul di katalog belum tentu bisa dipakai untuk inference dari Anticode.
- Jangan menyamarkan identitas aplikasi untuk melewati penolakan akses provider.
- Simpan token melalui secure storage OS dan tangani pembaruan token per akun.
- Jaga UI ringkas; tampilkan alasan kegagalan yang jelas dan tindakan yang relevan.

## Banyak akun dan usage

Pembagian akun berlaku untuk seluruh layanan subscription yang terintegrasi,
termasuk provider yang ditambahkan nanti; bukan khusus Cline. Pada setiap
prompt baru dalam sesi yang sama, pilih ulang akun yang memenuhi syarat dari
layanan yang sama dengan model yang sama berdasarkan kesibukan dan penggunaan.
Jangan menunggu akun pertama habis. Mekanisme ini tetap berlaku saat rotasi
model dimatikan. Tool dalam satu run melanjutkan akun run tersebut. Untuk
subscription berbasis beberapa API key dalam satu provider, key pool memakai
kebijakan pembagian usage yang sama, tanpa menganggap key berbeda pasti
menambah kuota akun. Jangan mencampur akun layanan berbeda atau rute berbayar.

Akun berbeda dapat ditambahkan pada provider yang sama. Login ulang identitas yang sama
memperbarui kredensial akun tersebut, bukan membuat slot kuota baru. Gunakan identitas akun
provider ketika tersedia; email saja belum tentu membedakan akun atau workspace.

Distribusi usage harus mempertimbangkan akun yang sedang dipakai, cooldown, dan kuota yang
dilaporkan provider. Pembatasan model tidak boleh menandai seluruh akun habis kuota. Saat semua
sumber yang memenuhi syarat tidak tersedia, hentikan routing dengan alasan yang jelas.

Pisahkan catatan token bulanan lokal dari kuota subscription yang dilaporkan provider. Jangan
menyebut token lokal sebagai sisa kuota, atau menjanjikan pemakaian tanpa batas.

## Pelajaran dari Cline

`cline-free/minimax-m3.1-flash` dan `cline-free/nemotron-3.5-super-vl` ditolak untuk
Anticode, sementara rute publik `minimax/minimax-m3.1-flash:free` dan
`nvidia/nemotron-3.5-super-vl:free` berhasil diuji pada 21 Oktober 2026.

Pilih rute publik ekuivalen hanya jika tersedia di katalog akun. Deduplicasi pilihan dan
pulihkan pemilihan alias lama melalui rute yang sesuai. Jangan menebak alias gratis untuk
model lain atau menganggap hasil ini berlaku selamanya.

Laguna S/XS 2.1 tidak menerima input gambar pada integrasi ini. Periksa juga gambar dalam
riwayat percakapan ketika pengguna mengganti model atau mengirim “lanjut”. Gambar baru tetap membutuhkan model vision. Untuk pertanyaan teks berikutnya,
riwayat gambar lama dapat diganti penanda eksplisit hanya pada request model teks, disertai
pemberitahuan di UI. Simpan gambar asli untuk pemulihan sesi dan pergantian kembali ke vision;
jangan mengarang isi gambar atau menghapusnya dari transkrip.

## Verifikasi sebelum menyatakan berhasil

1. Pastikan akun tersambung dan request memakai endpoint, skema autentikasi, serta ID model
   yang benar melalui adapter Anticode.
2. Pastikan streaming menghasilkan jawaban nyata. HTTP 200 atau login berhasil saja tidak cukup.
3. Uji tool calling sampai hasil tool diterima dan tugas sederhana benar-benar selesai.
   Jawaban sapaan tidak membuktikan kemampuan coding.
4. Uji gambar untuk rute vision dan penolakan yang jelas untuk model teks, termasuk gambar
   dari riwayat chat. Uji pergantian model dan pemulihan sesi lama.
5. Uji beberapa akun, login ulang akun yang sama, pembaruan token, kehabisan usage dan cooldown.
6. Pastikan penolakan akses tidak menyebabkan retry tanpa batas atau fallback berbayar.
   “Lanjut” tidak boleh mengulang tool yang sama tanpa kemajuan atau informasi baru.
7. Tambahkan tes regresi untuk bug yang diperbaiki, jalankan pemeriksaan terkait, lalu verifikasi
   paket aplikasi sebelum memasang pembaruan.

Bedakan bukti fixture dari pengujian provider nyata. Catat model/rute, waktu pengujian, status,
ada tidaknya jawaban, dan keterbatasan tanpa menyimpan token atau data percakapan pribadi.
Jangan menandai seluruh provider/model sebagai teruji berdasarkan satu probe.

## Lokasi implementasi dan pemeriksaan

- Akun, login dan adapter akun: `src/main/auth/`.
- Katalog akun dan penanganan akses rute: `src/main/auth/catalogue.ts`.
- Adapter model: `src/main/providers/`; kapabilitas gambar bersama: `src/shared/ipc.ts`.
- Kebijakan subscription, kuota dan distribusi: `src/main/subscriptions.ts`,
  `src/main/subscriptionQuotas.ts`, `src/main/rotation.ts`.
- Uji Electron dengan fixture terisolasi: `scripts/verify-cline-free.mjs`,
  `scripts/verify-multiple-accounts.mjs`, `scripts/verify-native-subscriptions.mjs` dan
  `scripts/verify-agent-loop.mjs`. Ini tidak membuktikan akses akun nyata.
- Smoke test paket: `scripts/verify-packaged.mjs`.
- Bukti dan riwayat investigasi: [catatan riset](research/opencode-9router.md).

Perintah dasar: `npm run typecheck`, `npm test`, dan `npm run build`. Sesuaikan pemeriksaan
integrasi dengan perubahan; lakukan probe nyata yang terbatas jika diperlukan untuk memastikan
akses provider, tanpa membocorkan kredensial atau mengubah pengaturan akun pengguna.


## Composer dan pembagian akun/key (0.0.69)

Header setiap layanan subscription mempunyai sakelar Composer untuk mengaktifkan atau
menonaktifkan seluruh akun sekaligus. Sakelar per akun tetap tersedia; header menampilkan
status campuran dan jumlah aktif bila sebagian akun dimatikan. Untuk akun auth, Composer OFF
juga mengecualikan akun dari routing manual dan rotation pada prompt berikutnya, termasuk
ketika akun tersebut masih dipilih di sesi lama. Run yang sudah berjalan tidak dibatalkan.
Jika semua akun model dimatikan, tampilkan alasan dan minta pengguna mengaktifkan akun.
Keanggotaan rotation dan kredensial tetap disimpan; mengaktifkan kembali memulihkan pilihan.


Sakelar Composer disimpan terpisah dari kredensial dan keanggotaan rotation. Provider/akun
baru tidak otomatis terlihat; migrasi profil lama hanya mempertahankan provider default yang
sebelumnya dipilih. Menyembunyikan sumber tidak membatalkan sesi atau menghapus akun.

Composer dan Settings → Models menggabungkan akun auth per layanan. Pemilihan model berlaku
untuk akun-akun pada layanan tersebut yang menawarkan model itu. Tambahan akun mewarisi model
yang dipilih pada akun sejenis setelah katalog tersedia. Login ulang identitas yang sama tetap
memperbarui akun lama. Pemilihan model manual juga membagi request antar-akun sejenis tanpa
harus mengaktifkan rotasi model; model dan keluarga layanan tidak berubah saat berganti akun.

Pembagian ini memakai catatan token bulanan lokal dan kesibukan akun, serta melewati cooldown
atau kuota habis yang telah diketahui. Itu bukan pengukuran sisa kuota subscription. Fallback
antar-akun dibatasi ke kegagalan sementara/autentikasi/kuota sebelum keluaran berguna muncul;
kesalahan kapabilitas atau penolakan produk tidak boleh diatasi dengan menghabiskan semua akun.

Provider API menyimpan primary key dan tambahan key terenkripsi dalam satu provider. UI hanya
menerima jumlah key, bukan isi key yang tersimpan. Pemakaian/cooldown key menggunakan hash,
bukan token mentah. Key baru ditambahkan melalui Edit → Add API keys, satu per baris; key
berulang dideduplicasi. Primary key dapat diganti lewat field API key. Request teks dibagi
antar-key dengan daftar model/endpoint yang sama; key yang gagal diperlakukan terbatas dan
respons parsial tidak direplay. Tambahan key tidak otomatis menambah kuota jika akun asal sama.
Generate image mempertahankan jalur primary key dan belum dibagi lewat key pool.

Pemeriksaan tambahan: `scripts/verify-composer-visibility.mjs` dan
`scripts/verify-provider-keyring.mjs`. Uji beberapa akun juga memverifikasi empat request Cline
dengan model tetap, dua request per akun, saat rotasi model dimatikan.

## OpenCode Go dan CodeBuddy: status persiapan

OpenCode Go menggunakan endpoint `https://opencode.ai/inference/go/`, bukan Zen/PAYG.
Model dipetakan ke Chat Completions, Responses, Anthropic, atau Google sesuai tabel resmi.
Anticode mengirim user agent miliknya dan `x-opencode-session` yang stabil untuk percakapan,
termasuk request compaction. Katalog bawaan adalah snapshot rute yang didokumentasikan,
bukan bukti bahwa akun mendapat semua model. Perubahan katalog/rute memerlukan verifikasi ulang.
Key disimpan lewat secure storage; akses inference baru dapat dipastikan melalui request akun.
Extra usage di Console dapat memakai saldo PAYG setelah kuota habis; pengguna perlu mematikannya.
Anticode tidak membeli paket, mengaktifkan Extra usage, atau mengganti endpoint saat ditolak.

CodeBuddy: login POST `/v2/plugin/auth/state?platform=CLI`, polling GET
`/v2/plugin/auth/token?state=…`, identitas dari `/v2/plugin/account`, dan refresh grant POST
`/v2/plugin/auth/token/refresh` mengikuti sumber CLI resmi 2.171.0. Account service memakai
kredit yang dapat mencakup paket dan top-up; OAuth saja belum membuktikan subscription bulanan.
Karena itu entitlement CodeBuddy tetap unknown dan tidak otomatis masuk subscription-only
routing sampai hak akses tersebut diverifikasi. Login, refresh dan jalur request disiapkan;
keberhasilan memakai kredit paket nyata belum diuji tanpa akun pengguna.

Sumber resmi yang diperiksa 21 Oktober 2026:

- [OpenCode Go: endpoint, identitas klien dan batas usage](https://opencode.ai/v2/docs/console/go).
- [CodeBuddy login](https://www.codebuddy.ai/docs/cli/quickstart).
- [CodeBuddy credits](https://www.codebuddy.ai/docs/ide/Account/credits).
- Paket npm resmi `@tencent-ai/codebuddy-code@2.171.0`, `product.json` dan implementasi auth.

Uji empat protokol Go memverifikasi tool call dan replay hasil tool dengan fixture melalui SDK
sebenarnya. Ini bukan pengujian layanan Go atau CodeBuddy dengan subscription nyata.

## Pemulihan sesi dan token — 21 Oktober 2026

Lihat [laporan pemulihan sesi](research/session-recovery-2026-10-21.md) untuk batas bukti terbaru.
CodeBuddy kini mengirim metadata percakapan dengan identitas Anticode. Satu probe nyata
`deepseek-v4.1-flash` sudah berhasil sampai hasil tool diterima dan jawaban akhir keluar;
ini belum membuktikan bahwa usage berasal dari subscription, bukan kredit akun.

Gangguan sementara saat refresh tidak boleh dianggap login mati. Refresh yang berhasil hanya
membersihkan cooldown autentikasi, bukan menghapus batas kuota. Key yang meminta verifikasi
email dapat dilewati berdasarkan kode error akun yang eksplisit; penolakan model/produk
tidak boleh dicoba berulang pada semua key. Respons parsial tetap disimpan dan tidak direplay.

Pemeriksaan tambahan: `scripts/verify-session-recovery.mjs` untuk gambar historis, pergantian
model, stream putus, hasil sementara, restart, dan melanjutkan sesi melalui SDK sebenarnya.

## Claude paste-code dan preset gratis

Lihat [catatan Claude dan preset gratis](research/claude-free-connections-2026-10-21.md).
Kode Claude harus berasal dari percobaan PKCE Anticode yang aktif. UI menerima `code#state`
atau callback URL dan menyamarkan input; kredensial tersimpan melalui secure storage.
Login Claude tidak otomatis membuktikan hak inference atau billing subscription.

Preset OpenCode Free, OpenRouter Free dan Kilo Gateway Free membatasi model pada rute gratis
sejak penyimpanan konfigurasi sampai pembuatan request, termasuk sesi lama yang masih
menyimpan ID berbayar. OpenCode Go tetap terpisah. Uji Electron tambahan:
`scripts/verify-claude-auth.mjs` (fixture; bukan probe subscription nyata).

Claude membaca katalog akun melalui `/v1/models` dengan pagination dan mempertahankan
snapshot terakhir ketika offline. Model terbaru yang teramati: Sonnet 5.5, Opus 5.5,
Haiku 5.5. Panel kuota membaca profil serta `/api/oauth/usage`; jendela 5 jam/7 hari
bukan jatah token bulanan lokal. Pemeriksaan sebelum inference menolak langganan tidak
aktif serta Extra usage yang aktif/tidak diketahui. Status profil ini tetap berbeda
dari bukti hak billing pihak ketiga: Claude tetap `billing: unknown`, tidak otomatis
masuk routing subscription-only. Probe nyata Sonnet/Haiku 5.5 masih mendapat 429;
login berhasil tidak boleh dilaporkan sebagai inference berhasil.

Preset Kilo Free menerima API key opsional dan dapat mengirim request anonim tanpa
Authorization. Penolakan key tidak menyebabkan fallback anonim. Dua request nyata
MiniMax M3.1 Flash Free melalui adapter Anticode sudah lulus tool round trip. Probe
anonim OpenCode Free ditolak 403 karena pembatasan klien resmi; jangan menyamarkan
Anticode atau menganggap key akan otomatis mengatasi pembatasan produk tersebut.

## Request capacity dan pilihan login (0.0.61)

Lihat [laporan akses provider](research/provider-access-fixes-2026-10-21.md).
`402 Prompt tokens limit exceeded` adalah batas ukuran request, bukan bukti saldo habis.
Key boleh dicoba untuk request lebih kecil tanpa cooldown kuota. Agent dapat membuat satu
ringkasan lokal konteks lama untuk retry; transkrip asli tetap disimpan dan respons parsial
tidak direplay. Batas request sistem/tool yang terlalu besar tetap harus dilaporkan.

Auth provider kini juga menawarkan OpenRouter Free dengan PKCE browser, Kilo Free dengan
persetujuan perangkat browser, serta MiniMax Token Plan melalui portal dan key `sk-cp`.
OpenRouter/Kilo hanya menerima rute gratis dalam katalog; MiniMax memvalidasi endpoint paket
serta daftar model plan yang didukung. Login baru tersebut diuji dengan fixture, bukan klaim
bahwa akun pengguna telah tersambung atau seluruh model telah lulus benchmark coding.

Provider custom OpenCode juga mengirim identitas Anticode dan header sesi stabil. Go tetap
memerlukan paket/key Go; Free pada probe akun nyata menolak akses dari luar aplikasi resmi.
Jangan menyamakan status login, model bernama free, dan hak inference pihak ketiga.

## Verifikasi ClinePass — 22 Oktober 2026

Probe GET langsung dengan key yang sudah tersimpan berhasil HTTP 200 pada
`/api/v1/users/me/plan/usage-limits` dan `/api/v1/users/me/plan`. Jendela yang
teramati: five_hour 0%, weekly 34%, monthly 17%. Ini bukti pembacaan kuota,
bukan pengujian inference baru atau benchmark coding. Tidak ada secret disimpan
di laporan. Sumber protokol akun:
[account service resmi Cline](https://github.com/cline/cline/blob/main/sdk/packages/core/src/account/cline-account-service.ts),
[dokumentasi ClinePass](https://github.com/cline/cline/blob/main/docs/getting-started/clinepass.mdx).
