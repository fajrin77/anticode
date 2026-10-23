# Routing, batas request dan grup Rotate — 23 Oktober 2026

Perbaikan ini menyusul screenshot pada versi 0.0.88: dashboard tetap Rotate
setelah memilih model manual, grup berisi pasangan Laguna/Claude yang tidak
sesuai, batas request key lebih kecil dari konteks, dan varian gratis yang
sudah dihentikan. Perubahan belum dipublish atau dipasang ke aplikasi pengguna.

## Perilaku

- Pilihan dashboard disimpan pada draft, termasuk setelah renderer dimuat ulang.
  Sesi baru menerima pilihan itu sebelum prompt pertama, tanpa mengganti sesi
  lain. Dashboard bisa kembali ke Rotate, juga ketika belum ada grup.
- Add model dalam grup membuka pencarian layanan/model. Satu klik layanan
  mengambil model yang ditawarkan setiap akun layanan itu. Klik model mengambil
  rute bernama sama lintas akun/layanan; ID provider dan model asli tetap dipakai.
  Katalog tiap akun dibaca terpisah; tidak ada penyalinan ID ke akun lain.
  Duplikat dihapus oleh penyimpanan grup. Pilihan satu akun/model tetap tersedia.
- Penambahan massal mengambil model baru hanya dari sumber berlabel free atau
  subscription. Sumber metered/unknown hanya membawa model yang sudah dipilih
  pengguna dan masih tercantum dalam katalognya. Ketentuan subscription-only,
  Composer OFF dan pemeriksaan entitlement saat inference tetap berlaku.
- Pasangan akun auth/model diperiksa sebelum dipilih dan sebelum adapter dibuat.
  Adapter akun memeriksa katalog juga; akun Claude menolak keluarga model asing.
  Entri lama yang tidak cocok ditampilkan sebagai unavailable dengan alasan dan
  tombol Replace, tanpa diam-diam menghapus konfigurasi pengguna. Endpoint custom
  tetap menerima ID yang dikonfigurasi secara eksplisit; jenis protokolnya tidak
  dipakai untuk menebak keluarga model yang ditawarkan endpoint tersebut.
- Error aplikasi tampil di bawah tab bar; detail panjang membungkus teks dan
  dapat discroll. Error provider tidak menampilkan JSON, ID akun, kredensial atau
  saran perpindahan berbayar dari payload upstream.
- Batas input dipertahankan sebagai metadata terstruktur, termasuk melalui
  wrapper error. Agent mencoba satu pemadatan lokal per rute/skema dalam request:
  ringkasan riwayat lama dan pemendekan hasil tool/prosa besar. Prompt pengguna
  terbaru, input tool, pasangan call/result dan batas kapabilitas dipertahankan.
  Transkrip lengkap tetap tersimpan; tool yang selesai tidak dipanggil ulang.
- Bila instruksi/tool/input wajib tetap melebihi batas, error menjelaskan bahwa
  allowance key tidak cukup. Bukti allowance disimpan 60 detik dalam sesi,
  terpisah per provider/akun, model dan hash instruksi/skema tool; Continue yang
  tetap terlalu besar tidak langsung dikirim ulang. Bukti lokal tidak
  diperpanjang oleh penolakan preflight. Nilai token preflight berupa estimasi.
  Rotate hanya mencoba rute dalam grup aktif; pemilihan manual hanya bisa mencoba
  akun layanan yang sama dengan model sama. Ini tidak menandai kuota habis atau
  memberi cooldown akun.
- Penolakan 404/410 dengan pesan eksplisit retired/discontinued/decommissioned
  menandai provider+model yang tepat selama 24 jam dan bertahan setelah restart.
  Refresh katalog tidak menghapus bukti itu karena katalog bisa stale. Setelah
  24 jam rute boleh diperiksa kembali. Bare 404, gangguan sementara dan metadata
  error lama tidak dianggap retirement. Tidak ada penambahan alias berbayar.

## Verifikasi

Semua hasil di bawah memakai profil sementara dan fixture lokal. Tidak ada
kredensial atau konfigurasi akun pengguna yang diubah.

- `npm run build`: typecheck Node/renderer dan build produksi lulus.
- `npm test`: 73 file, 790 tes lulus. Meliputi pasangan Laguna/Claude lama,
  penjagaan adapter sebelum autentikasi/inference, lintas akun dan versi model,
  deduplikasi, retirement, key limit, konteks parsial dan tanpa replay tool.
  Fixture Claude lama yang memakai nama model generik diperbaiki agar memakai
  nama keluarga Claude/katalog fixture yang sah, bukan melonggarkan guard.
- `scripts/verify-rotation-workflow.mjs`: Electron UI, callback OAuth fixture,
  secure account store dan request SDK. Satu klik Cline mengambil dua akun dan
  dua model gratis; pencarian DeepSeek 4.1 Flash mengambil kedua akun dan tidak
  menggandakan rute pada penambahan ulang. Draft manual bertahan setelah reload,
  prompt pertama benar-benar memakai provider/model/key yang dipilih, sesi lain
  tetap Rotate; dashboard kembali Rotate dan tetap bisa dipilih tanpa grup.
- `scripts/verify-route-capacity.mjs`: retirement berpindah ke rute gratis yang
  sudah dipilih, tanpa paid fallback/cooldown; allowance 13.114/4.064 tidak
  dikirim berulang oleh Continue; hasil tool besar dipadatkan sampai request
  benar-benar muat dan selesai dengan satu eksekusi tool. Penolakan rute
  bertahan setelah restart dan refresh katalog.
- `scripts/verify-ui.mjs`: 233 pemeriksaan UI lulus, mencakup grup/provider link,
  pilihan individual, Settings, sesi, attachment, markdown, plan dan browser.
- `scripts/verify-rotate-picker.mjs`: pilihan manual/Rotate, grup aktif,
  pemisahan sesi, restart dan Rotate tanpa grup lulus.
- `scripts/verify-multiple-accounts.mjs`: distribusi ChatGPT/Cline lulus;
  25 prompt Cline dibagi ke lima akun tanpa mengubah model.
- `scripts/verify-provider-keyring.mjs`: distribusi dua key, penyimpanan
  terenkripsi dan pemulihan setelah restart lulus.
- `scripts/verify-session-recovery.mjs`: gambar historis/model teks, penolakan
  gambar baru, pemulihan stream parsial dan outcome terinterupsi lulus.
- `scripts/verify-tool-markup.mjs`: DSML terpotong tidak bocor ke chat,
  koreksi native mempertahankan approval, satu write dan hasil tool diterima;
  kegagalan berulang berhenti secara terbatas.

Ini bukan probe provider nyata, benchmark coding atau jaminan semua model dan
akun akan menerima inference. Katalog tidak membuktikan entitlement/kapabilitas.
Batas wajib yang lebih besar daripada allowance provider tidak dapat diperbesar
oleh aplikasi; bila semua rute pilihan tidak cukup, pekerjaan berhenti dengan
alasan yang jelas dan hasil yang sudah diterima tetap disimpan.
