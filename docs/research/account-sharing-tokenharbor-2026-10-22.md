# Pembagian akun dan TokenHarbor — 22 Oktober 2026

## Lima akun dengan model tetap

Profil pengguna mempunyai lima akun Cline. Mekanisme `accountCandidates` dan
`rankAccounts` sudah memilih ulang akun pada setiap prompt baru di sesi yang
sama: keluarga provider/model harus sama; akun tanpa model, cooldown, atau kuota
yang diketahui habis dilewati. Akun yang lebih senggang dan mempunyai catatan
token bulanan lokal lebih kecil didahulukan. Bukan menunggu akun pertama habis.

Ini otomatis bekerja meski rotasi *model* dimatikan. Tool dalam satu run tetap
melanjutkan akun run tersebut. Tidak ditambahkan aturan lima prompt berturut-turut:
permintaan pengguna menyebutnya sebagai contoh, dan pemilihan setiap prompt
sudah menyeimbangkan penggunaan lebih cepat. Catatan token bukan sisa kuota
subscription provider; prompt dengan panjang berbeda tidak selalu menghasilkan
jumlah prompt identik per akun.

Uji unit dan integrasi Electron/IPC memakai lima akun fixture, satu sesi, satu
model, dan 25 prompt berukuran sama. Kelima akun mendapat lima request; lima
prompt pertama sudah memakai lima akun berbeda. Login ulang akun yang sama
tidak menambah akun. Restart mempertahankan akun dan routing. Seluruh provider
response pada integrasi ini adalah fixture, bukan pemakaian subscription nyata.

## TokenHarbor

Konfigurasi saat diperiksa mempunyai tujuh key unik setelah deduplikasi hasil
dekripsi, berbeda dari lima yang disebut pengguna. Tidak ada key dihapus atau
ditampilkan. Endpoint tetap `https://tokenharbor.ai/v1`, dengan dua model eksplisit
`:free` yang sudah dipilih pengguna.

Hasil nyata:

- 14 request inference (dua model per key) timeout pada batas diagnostik awal
  15 detik tanpa jawaban. Ini tidak membuktikan bahwa inference akan gagal
  selamanya atau key salah.
- `/models` dengan ketujuh key timeout sebelum header, baik lewat Node fetch
  maupun Electron net, pada batas 10 detik.
- Request tanpa key dan key palsu ditolak cepat dengan HTTP 401.
- Request `/models` dengan primary key melalui curl juga timeout (12 detik,
  exit 28, tanpa status HTTP). Key diberikan lewat stdin, bukan argv atau log.

Perbandingan tersebut mengarah ke kegagalan/kelambatan jalur autentikasi atau
lookup akun di layanan, bukan kerusakan khusus transport Anticode. Tidak ada
respons provider yang membuktikan key dicabut, email belum diverifikasi, atau
kuota habis pada pengujian ini. Satu probe historis 21 Oktober pernah berhasil;
hasil itu tidak menjamin layanan saat ini.

Adapter menunggu data pertama maksimal 60 detik dan dapat mencoba key berikutnya
sebelum ada output; karena itu pool yang seluruh request-nya menggantung dapat
terlihat diam beberapa menit. Mengganti model gratis ke model berbayar tidak
dilakukan. Tidak ada alasan untuk menghapus seluruh key atau mengubah endpoint
berdasarkan timeout saja.

Laporan lokal tanpa kredensial disimpan di `/tmp/anticode-tokenharbor-*-20261022.json`.
Diagnostik dapat diulang melalui `scripts/probe-tokenharbor.mjs --catalogue`.

Dokumentasi resmi menyatakan rute gratis memakai ID eksplisit `:free` dan hak
akses bergantung status akun: [FAQ TokenHarbor](https://tokenharbor.ai/faq).
