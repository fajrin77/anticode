# Pemulihan sesi dan routing akun — 21 Oktober 2026

## Perbaikan

- Samakan klasifikasi gangguan koneksi, autentikasi, kuota dan kegagalan permanen pada
  rotasi akun serta key pool. Akun/key yang gagal setelah sebagian jawaban keluar tetap
  mendapat cooldown; request yang sudah menulis jawaban tidak direplay. Continue memakai
  transkrip tersimpan dan dapat memilih sumber lain yang memenuhi syarat.
- Catat kegagalan key/akun tunggal sebelum sumber kedua ditambahkan. Pertahankan scope
  model versus akun dan waktu reset provider. Kode `email_verification_required` merupakan
  penolakan akun, berbeda dari pembatasan model/klien; key sehat lainnya tetap dapat dipakai.
- Pembaruan token diperiksa sebelum request dan setelah penolakan token. Refresh serentak
  tetap memakai satu grant per akun. HTTP 503/gangguan jaringan saat refresh tidak menjadi
  login mati dengan cooldown enam jam. Refresh berhasil membersihkan cooldown login lama,
  tanpa menghapus penanda kuota. Request refresh dibatasi 15 detik.
- CodeBuddy menerima metadata percakapan yang tidak dikirim adapter sebelumnya:
  `X-Conversation-ID`, `X-Conversation-Request-ID`, `X-Conversation-Message-ID`.
  Identitas aplikasi tetap Anticode; tidak menggunakan identitas perangkat/klien palsu.
  Chunk dengan nama/id tool kosong tidak lagi menghapus identitas tool dari chunk sebelumnya.
  Penolakan 11128 yang masih terjadi dijelaskan sebagai pembatasan kanal, bukan token habis.
- Gambar lama diganti penanda eksplisit hanya dalam request model teks, dengan pemberitahuan.
  Gambar asli tetap tersimpan dan tersedia ketika kembali ke model vision. Gambar baru pada
  model teks tetap ditolak. Jalur ini juga berlaku untuk Continue dan sesi yang dibuka kembali.
- Model `:batch` disaring dari katalog chat dan pool; pilihan sesi lama ditolak sebelum request.
- Stream tanpa penanda selesai tidak dianggap jawaban akhir dan tidak mengeksekusi tool parsial.
  Berlaku untuk Chat Completions, Responses, Codex, Google dan Anthropic.
- Status akhir tersimpan membedakan selesai, dijeda, error, batas respons dan penolakan.
  Desktop menampilkan panel hasil sementara yang seragam dan satu kelompok langkah yang
  dapat dibuka. Instruksi laporan akhir berlaku lintas model; kualitas tulisan model tetap
  dapat berbeda. Panel sementara memakai fakta lokal, bukan rangkuman karangan saat offline.

## Pengujian fixture

- `npm test -- --maxWorkers=1 --reporter=dot`: **57 file, 572 tes lulus**.
- `npm run build`: typecheck Node/web dan build lulus.
- `scripts/verify-session-recovery.mjs`: Electron → IPC → runtime → SDK → SSE; gambar lama,
  penolakan gambar baru, kembali ke vision, kelompok langkah, stream putus, status akhir
  tersimpan, restart, dan melanjutkan sesi. Tujuh request fixture, tanpa layanan eksternal.
- `scripts/verify-provider-keyring.mjs`: dua key, pembagian request, UI dan penyimpanan
  terenkripsi, serta pemulihan setelah restart.
- `scripts/verify-multiple-accounts.mjs`: dua akun ChatGPT dan dua akun Cline; pembagian
  request, model tetap, login ulang identitas sama, dan persistensi routing.
- `scripts/verify-native-subscriptions.mjs`: quota gagal pada akun pertama, akun kedua
  menerima tool dan menyelesaikan tugas fixture; persistensi katalog/routing setelah restart.
- Fixture tambahan mencakup routing kelima jenis akun: ChatGPT, Claude, Cline, OpenCode Go,
  CodeBuddy; refresh empat jenis akun yang mendukung renewal; empat protokol OpenCode Go.

Tes awal terhambat disk penuh dan cache Chromium yang hilang. Fixture batas ukuran 101 MB
sekarang memakai berkas sparse berukuran sama. Chromium headless untuk tes dipulihkan;
pengujian menyeluruh terakhir lulus. Tidak menghapus berkas pribadi untuk membebaskan disk.

## Probe provider nyata

Bukti terstruktur tanpa kredensial: [provider-access-2026-10-21.json](provider-access-2026-10-21.json).
Probe awal mencakup 26 kombinasi sumber/key/akun dengan model terpilih; satu sumber lain
dilewati karena belum memilih model. Tidak menguji seluruh model dalam setiap katalog.

| Sumber/rute | Hasil yang diamati |
| --- | --- |
| ChatGPT, `gpt-5.6-sol` | Satu putaran tool dan jawaban akhir berhasil. |
| Clinepass, `cline-pass/glm-5.3-flash` | Satu putaran tool dan jawaban akhir berhasil. |
| Hive dan Hive 2, `zai-org/glm-5.3-flash` | Kedua sumber berhasil sampai hasil tool diterima dan jawaban akhir. |
| Token Harbor, `deepseek-v4.1-flash:free` | Satu key berhasil sampai jawaban akhir; key lain ditolak karena email belum diverifikasi. |
| CodeBuddy, `deepseek-v4.1-flash` | Jawaban teks berhasil. Setelah perbaikan nama tool kosong, `read_file` → hasil fixture → `OK` berhasil; 665 input / 40 output token pada dua request tersebut. |
| Lima akun Cline | Access token tersimpan ditolak 401 pada probe langsung tanpa refresh. Ini belum membuktikan refresh grant atau sesi login tidak dapat dipulihkan. |
| OpenRouter, model Muse Contributor terpilih | Tujuh key unik menerima 404; tidak beralih otomatis ke model berbayar lain. |
| Wildanoel dan Free Minimax | Kredensial terpilih ditolak 401. |
| Kiosapi dan 9router | Endpoint tidak terjangkau saat probe. |
| Xkiro dan Typsafe | Rute/model terpilih mendapat 404. |
| Muse Code, `muse-spark-1.3-contributor` | Ada tahap awal, tetapi putaran tool tidak menghasilkan jawaban akhir; belum dinyatakan berfungsi. |
| Nexaworks | Belum ada model terpilih; tidak mengirim inference. |

Probe nyata menggunakan adapter langsung dengan access token yang sudah tersimpan dan prompt
uji tanpa data percakapan pengguna. Tidak menerbitkan refresh grant nyata dari proses kedua,
mengubah kredensial, mengubah pengaturan akun, atau memakai fallback berbayar. Karena proses
probe terpisah, usage probe tidak masuk jurnal usage Anticode. Hasil tidak membuktikan
entitlement subscription CodeBuddy, semua model provider, ataupun kemampuan coding umum.
Claude dan OpenCode Go belum memiliki akun nyata pada profil yang diperiksa; buktinya fixture.

Build diperiksa; aplikasi terpasang tidak diganti dan sesi pengguna tidak dihentikan.
