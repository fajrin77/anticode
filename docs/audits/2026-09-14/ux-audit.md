# Audit pemakaian Anticode — 14 September 2026

> Tindak lanjut: perbaikan dan pengujian terbaru ada di [hasil perbaikan](fixes.md). Label “terbuka” di dokumen ini merekam keadaan audit awal.

Permintaan: memakai aplikasi seperti pengguna yang membuat prompt, mengelola sesi, mengunggah/mengunduh berkas, menjeda/melanjutkan pekerjaan, memilih model/provider, dan memakai computer use; memperbaiki geseran dua jari yang terlalu cepat dan hanya berfungsi di bar tab.

## Hasil utama

Gesture diperbaiki di kode dan build lokal. Geseran dua jari sekarang diterima pada isi sesi, termasuk transkrip chat, serta bar tab. Satu gesture memilih satu sesi tetangga setelah gerakan berhenti. Konten mengikuti arah gerakan, menampilkan petunjuk tepi, lalu masuk/keluar dengan animasi. Geseran pendek kembali ke tempat semula. Tidak ada perpindahan melingkar dari tab terakhir ke pertama.

Parameter awal: ambang 110 piksel terakumulasi, jeda akhir gesture 220 ms, animasi keluar 160 ms dan masuk 280 ms. Reduced motion menghilangkan animasi transformasi. Wheel vertikal, editor prompt, dialog, menu, dan konten dengan scroll horizontal tidak diambil alih. Panel browser tetap mengelola interaksinya sendiri.

Perubahan belum dipaketkan menjadi installer atau dipasang menggantikan aplikasi di /Applications. Pengujian ini tidak mengukur rasa trackpad fisik; masih diperlukan penyesuaian berdasarkan pemakaian perangkat nyata.

## Metode dan batas bukti

- Menjalankan Electron asli memakai profil dan workspace sementara, provider HTTP lokal dengan respons terkontrol, serta berkas fixture. Tidak memakai kredensial provider pengguna.
- Menjalankan alur UI, IPC, streaming, tool execution, browser, sinkronisasi desktop–ponsel, restart, dan download; sebagian setup fixture dilakukan melalui IPC/store. Ini bukan seluruhnya klik manual.
- Tes khusus gesture memakai WheelEvent pada renderer Electron. Ini membuktikan pengenalan event, perilaku navigasi, state draft dan animasi; tidak membuktikan karakteristik momentum hardware macOS.
- Percobaan akses aplikasi melalui skill computer-use timeout; percobaan penemuan aplikasi juga timeout. Tidak ada klaim telah mengontrol aplikasi macOS pengguna secara langsung.
- Temuan di bawah yang berlabel inspeksi kode belum direproduksi dengan provider internet atau dialog file native. Prioritas P1 berarti berpotensi kehilangan konteks/hasil yang diharapkan; P2 berarti hambatan kenyamanan atau kejelasan.

## Temuan detail

### 1. P1 — satu gesture bisa melompati beberapa sesi; hanya bar tab yang menerima geseran — diperbaiki

Sebelumnya `TabBar.tsx` langsung memanggil pemilihan sesi untuk setiap wheel event horizontal >=12. Trackpad menghasilkan banyak event, termasuk momentum; tidak ada akumulasi, fase pelepasan atau penguncian satu gesture. Area isi chat tidak punya handler tersebut.

Perbaikan: satu listener native non-passive di tingkat aplikasi, permukaan gesture yang eksplisit, penguncian sumbu, ambang terakumulasi, animasi, dan perlindungan terhadap perpindahan sesi langsung ketika gesture masih menunggu selesai.

Bukti tes: gesture pendek tidak berpindah; 12 event besar hanya maju satu sesi; delta 1,5 piksel berulang tetap bisa berpindah; bar tab dan transkrip sama-sama bekerja; draft bertahan; batas tab tidak melingkar; scroll vertikal/editor/blok kode tidak dicegat; Settings tidak ikut bernavigasi. Lihat `swipe.log` dan `scripts/verify-session-swipe.mjs`.

### 2. P1 — mengirim saat lampiran masih diproses bisa mengirim prompt tanpa berkas — terbuka, inspeksi kode

Skenario reproduksi lanjutan: ketik prompt, pilih/paste berkas yang memerlukan waktu persiapan, segera tekan Enter sebelum kartu lampiran muncul.

`Composer.collect()` menunggu proses berkas selesai baru menambah lampiran. `canSend` hanya memeriksa teks dan kesiapan sesi/provider; tidak memeriksa upload/persiapan yang masih berjalan. `DropZone.stage()` juga melakukan persiapan async tanpa status bersama dengan tombol kirim. Akibat yang diperkirakan: prompt berjalan dengan daftar lampiran lama; berkas baru tiba pada draft setelah pengiriman.

Saran: simpan jumlah persiapan per sesi; tampilkan nama/status berkas sejak dipilih; tahan pengiriman sampai lampiran siap atau sengaja dibatalkan. Uji dengan proses berkas yang diperlambat secara deterministik.

### 3. P1 — lampiran draft tidak bertahan setelah restart — terbuka, dikonfirmasi struktur penyimpanan

Skenario: lampirkan berkas tanpa mengirim, restart, buka draft yang sama. Teks draft dipersist, tetapi `store/session.ts` sengaja menulis `attachments: []` pada metadata. Registri lampiran di main process memakai Map dalam memori dan tidak dipersist.

Dampak: teks tetap ada tetapi berkas pendukung perlu dipilih lagi; tanpa pemberitahuan pengguna bisa mengira draft utuh. Percakapan yang sudah dikirim berbeda: pemulihan riwayat setelah restart lolos pengujian.

Saran: persist referensi yang dapat divalidasi/di-stage ulang; berkas yang hilang harus menjadi kartu kegagalan yang terlihat, bukan dihapus diam-diam.

### 4. P2 — kembali ke sesi menghilangkan posisi baca — terbuka, inspeksi kode

Skenario: gulir ke tengah percakapan panjang, pindah sesi, lalu kembali. Di `SessionView.tsx`, perubahan session ID membuat `following.current = true`, kemudian `scrollTop = scrollHeight`. Tidak ada posisi baca per sesi pada alur ini.

Dampak: pengguna perlu mencari ulang paragraf yang sedang dibaca, terutama setelah gesture mempercepat perpindahan sesi.

Saran: simpan posisi scroll dan status mengikuti output per sesi; pulihkan ketika kembali. Tetap turun otomatis bila pengguna mengirim prompt atau memang berada di bawah.

### 5. P2 — Pause tidak tersedia pada tombol utama saat draft berisi teks — terbuka, inspeksi kode

Skenario: jalankan prompt lambat, mulai mengetik instruksi berikutnya, lalu ingin menjeda pekerjaan. `steering` menjadi true ketika streaming dan draft tidak kosong; tombol beralih menjadi Send/Queue, dan cabang klik mengirim sebelum memeriksa Pause.

Pause/Continue pada draft kosong berhasil diuji, termasuk lintas desktop–ponsel. Hambatannya khusus ketika pengguna sedang menyiapkan instruksi sambil ingin menghentikan run.

Saran: sediakan kontrol Pause terpisah yang tetap terlihat selama run aktif. Continue juga perlu menjelaskan bahwa ia mengirim instruksi lanjutan dari riwayat, bukan melanjutkan proses OS yang dibekukan tepat pada instruksi sebelumnya.

### 6. P2 — batch drag-and-drop campuran bisa menyembunyikan berkas yang berhasil — terbuka, inspeksi kode

`DropZone.stage()` menjalankan batch path dan beberapa batch byte dengan `Promise.all`. Jika satu batch gagal, hasil batch lain yang sudah berhasil terdaftar tidak dimasukkan ke draft, karena seluruh agregasi menuju catch. Registrasi path dalam satu batch memang sudah atomic; masalah ini ada pada agregasi beberapa batch yang berbeda.

Skenario lanjutan: drop beberapa berkas tanpa path, salah satunya tidak dapat diproses. Saran: pakai hasil per berkas/batch, tampilkan keberhasilan dan kegagalan masing-masing, atau lepaskan semua hasil sukses jika memilih kontrak atomic.

### 7. P2 — tombol Download belum menunjukkan proses berlangsung — terbuka, inspeksi kode

`Artifacts.tsx` memanggil `saveArtifact()` setiap klik tanpa pending state atau menonaktifkan tombol. Berhasil menyimpan menampilkan tujuan, dan kegagalan tampil sebagai teks, tetapi fase menunggu tidak terlihat.

Dampak yang perlu direproduksi: klik berulang saat dialog/native copy lambat dapat menghasilkan permintaan simpan berulang. Download HTTP dan isi workbook hasil edit sudah lolos tes, tetapi dialog Save As macOS langsung belum diuji.

Saran: pending state per artefak, cegah permintaan ganda, pertahankan feedback keberhasilan dan beri retry pada kegagalan.

### 8. P2 — computer use bawaan belum mencakup kendali desktop penuh — keterbatasan fitur, inspeksi registri tool

Tool bawaan menyediakan navigasi/click/fill/screenshot browser dan screenshot seluruh layar macOS. Registri tool bawaan tidak menyediakan klik, ketik, drag atau pemilihan aplikasi pada desktop OS. MCP dapat menambahkan kemampuan lain; tidak ada validasi MCP desktop eksternal dalam audit ini.

Mode antichat hanya mendapat tool dokumen; browser, terminal dan screenshot layar tidak termasuk. Pengguna yang meminta aplikasi lain dibuka/dikendalikan di antichat tidak mendapat kemampuan itu dari tool bawaan.

Saran: tampilkan kemampuan yang tersedia per mode dan status izin Screen Recording; pisahkan browser automation dari desktop control dalam label produk. Sebelum menambahkan kontrol OS, tentukan approval dan isolasi per sesi. Izin Screen Recording nyata belum diuji.

### 9. P2 — kontrak tes tampilan tab aktif berbeda dengan implementasi — terbuka, teruji

Suite UI melaporkan 211 pemeriksaan lulus dan satu gagal: mengharapkan tab aktif tanpa latar/border, sedangkan `TabBar.tsx` yang sudah ada memakai `glass-control` dan garis lime untuk tab aktif. Perbaikan gesture tidak mengubah kelas tersebut.

Ini merupakan ketidaksesuaian desain/tes yang perlu diputuskan, bukan bukti bahwa seluruh alur UI gagal. Jangan menghapus assertion hanya untuk menghijaukan suite; sepakati apakah tab aktif harus memiliki kotak permanen, lalu selaraskan aturan desain dan tes.

## Alur yang berhasil diuji

| Alur | Bukti |
|---|---|
| Membuat prompt, streaming, sesi paralel | Respons selesai; sesi lain tidak mencampur hasil |
| Pause dan Continue | Berfungsi di desktop dan lintas ponsel; run selesai tidak meninggalkan Continue palsu |
| Follow-up/antrean/revert | Instruksi masuk ke run, riwayat tidak digandakan, prompt bisa dikembalikan |
| Upload gambar/workbook | Lampiran sampai transkrip dan workspace sesi yang benar |
| Edit berkas dan download | Workbook fixture diubah lalu hasil download dibaca kembali dan warna sel diverifikasi |
| Model/provider | Pergantian model mempertahankan riwayat; sinkronisasi model dan tambah/hapus provider terkontrol berhasil |
| Browser | Navigasi, tab browser, preview, back/forward dan pemulihan halaman berhasil |
| Restart | Sesi, riwayat percakapan dan metadata hasil pulih |
| Gesture desktop | Isi chat dan bar tab, threshold, arah, draft, batas, reduced motion dan pengecualian scroll lolos |

Pemilihan model/provider di atas memakai endpoint lokal. Validitas API key nyata, kuota, harga aktual, rate limit vendor, kualitas hasil model, kemampuan vision tiap vendor, serta kegagalan jaringan internet belum dibuktikan oleh audit ini.

## Validasi dan artefak

- `npm run build`: lulus typecheck dan build.
- `npm test`: 33 berkas, 347 tes lulus.
- `node scripts/verify-session-swipe.mjs`: seluruh pemeriksaan lulus.
- `node scripts/verify-desktop.mjs`: 52 kelompok pemeriksaan lulus; tidak ada renderer exception.
- `node scripts/verify-ui.mjs`: 211 pemeriksaan lulus, 1 ketidaksesuaian tab aktif seperti di atas.
- `git diff --check`: lulus saat audit.
- Log lokal: `build.log`, `unit.log`, `swipe.log`, `desktop.log`, `ui.log`. Token endpoint lokal disamarkan pada salinan log.
- `conversation.png`: screenshot transkrip fixture setelah perpindahan gesture; gambar sudah diperiksa untuk memastikan isi chat dan composer tampil.

Urutan lanjutan yang disarankan: cegah kirim sebelum lampiran siap → pemulihan lampiran draft → Pause tetap tersedia → posisi baca per sesi → hasil batch upload dan indikator download → penjelasan kemampuan computer use → pengujian trackpad fisik/provider nyata.
