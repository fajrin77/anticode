# Hasil perbaikan dan audit lanjutan — 14 September 2026

Perubahan sudah diterapkan di source dan dirilis sebagai **0.0.27**. Aplikasi di `/Applications/anticode.app` sudah diganti dan lolos smoke test dari lokasi terpasang. Installer dan salinan aplikasi versi lama sudah dihapus. Kredensial, data sesi, dan konfigurasi pengguna tidak dihapus; tidak ada pemasangan server MCP baru.

## Tindak lanjut seluruh temuan awal

| Temuan | Hasil |
|---|---|
| Gesture hanya di tab, terlalu cepat | Isi chat dan tab berbagi pengenal gesture; akumulasi, pelepasan, animasi, perlindungan momentum, reduced motion, dan pengecualian scroll/editor tetap lolos tes. |
| Kirim mendahului upload | Persiapan lampiran tercatat per sesi; tombol dan handler Enter menahan kirim sampai selesai. Status persiapan terlihat di Dashboard maupun sesi. |
| Lampiran draft hilang setelah restart | Metadata berkas dipersist tanpa thumbnail besar; ID diregistrasi ulang setelah startup. Berkas paste/drop disimpan di data aplikasi. Referensi hilang ditampilkan sebagai error dan menahan kirim sampai pengguna menanganinya. |
| Posisi baca hilang | Scroll dan status mengikuti output disimpan per sesi, dipulihkan ketika kembali, dan dicatat saat jendela ditutup/reload. Prompt baru tetap membawa pembaca ke akhir. |
| Pause hilang saat mengetik | Tombol Pause terpisah muncul saat tombol utama dipakai untuk Send/Queue; draft tidak dikirim atau dihapus. Kegagalan pause ditampilkan. |
| Satu drop gagal menyembunyikan semua hasil | Masing-masing berkas diproses independen; hasil sukses tetap ditambahkan, kesalahan per berkas terlihat dan tidak hilang lewat timer. |
| Download tanpa status, klik ganda | Tombol menampilkan Saving dan disabled selama proses. Main process juga menggabungkan permintaan bersamaan untuk berkas yang sama. Tujuan simpan terlihat setelah sukses; menyimpan ke path sumber tidak mencoba menyalin berkas ke dirinya sendiri. |
| Computer use tidak jelas | Settings → General menjelaskan tool per mode, browser versus desktop, serta status Screen Recording/Accessibility yang diperbarui saat kembali ke aplikasi atau menekan Refresh. Tooltip pemilihan mode dan pesan kegagalan screenshot diperjelas. |
| Tes tab aktif tidak sesuai desain | Penanda glass dan garis lime pada tab aktif dipertahankan. Aturan lokal serta tes diselaraskan; tes tetap memeriksa penanda yang terlihat. |

**Batas computer use:** perbaikan nomor 8 adalah kejelasan kemampuan dan izin sesuai rekomendasi audit. Browser/screenshot tetap bawaan; kontrol penuh aplikasi macOS tetap memerlukan tool dari server MCP yang dikonfigurasi. Perubahan ini tidak mengimplementasikan driver klik/keyboard desktop baru dan tidak mengklaim kemampuan yang belum ada.

## Temuan tambahan yang diperbaiki

1. **Draft Dashboard hilang saat membuka Settings:** teks, mode, folder dan lampiran Dashboard sekarang dipersist dengan identitas draft tersendiri. Upload yang masih berjalan tetap menuju Dashboard meski komponennya sudah ditutup.
2. **Dashboard belum punya alur paste/drop yang setara sesi:** kedua jalur sekarang memakai persiapan per berkas yang sama. Pengiriman pertama yang ditolak mengembalikan draft ke sesi yang dibuat.
3. **Upload selesai setelah sesi dihapus:** hasil tidak membuat ulang draft atau masuk ke sesi lain; ID lampiran dilepaskan. Penghapusan sesi juga membersihkan metadata draft/posisi baca.
4. **Lampiran yang dihapus saat pemulihan muncul lagi:** pemulihan memeriksa keberadaan chip sebelum memasukkan hasil, lalu melepas hasil yang sudah tidak diperlukan.
5. **Error saat mengambil kembali prompt antrean tidak tertangani:** kegagalan sekarang ditampilkan di composer.
6. **Nomor versi development salah:** App Info dan halaman update menggunakan versi paket Anticode, bukan versi runtime Electron.
7. **Teks mode Auto bertentangan dengan policy:** Dashboard, composer dan General sekarang menjelaskan skip risiko menengah, persetujuan risiko tinggi dalam Auto, serta izin tersimpan dalam Default. Policy izin sendiri tidak diubah.

## Bukti pengujian

- Build dan typecheck lulus.
- Unit: **34 berkas, 352 tes lulus**.
- Suite UI: **213 pemeriksaan lulus**, termasuk penanda tab aktif dan hover kontrol yang tidak aktif. Penyesuaian fixture memilih mode tidak aktif secara eksplisit karena Dashboard kini mengingat pilihan mode.
- Regresi gesture: seluruh pemeriksaan lulus, termasuk transkrip panjang, delta trackpad kecil, pembatalan oleh klik tab langsung, draft, dan reduced motion.
- Regresi workflow baru: **10 kelompok pemeriksaan lulus** menggunakan Electron asli, server provider lokal, profil terpisah dan berkas disposable.
- Suite desktop–ponsel: **52 kelompok pemeriksaan lulus**, tanpa renderer exception; hasil akhir tercatat dalam `fix-desktop.log`.
- `git diff --check` lulus.

Workflow baru memeriksa lewat UI/IPC: Pause sambil mengetik; Enter selama persiapan; Dashboard → Settings → kembali; drop dengan satu pembacaan sengaja dibuat gagal; restart proses penuh dengan lampiran; file sumber dihapus sebelum restart; kembali ke posisi scroll; dua permintaan Save As bersamaan; Saving/disabled/tujuan download; App Info serta izin OS.

Dialog Open/Save pada tes diganti handler fixture dengan jeda yang terkontrol agar race bisa diuji tanpa memilih berkas pengguna. Parsing, registrasi lampiran, penyimpanan, pengiriman request, restart, dan copy berkas tetap menjalankan implementasi aplikasi. Satu File fixture disuntik kegagalan `arrayBuffer()` untuk memverifikasi batch campuran; ini bukan klaim bahwa berkas XLSX rusak selalu ditolak saat attach.

## Batas validasi

- Rasa trackpad fisik belum diuji ulang; test gesture memakai event di renderer Electron.
- Provider internet, API key nyata, kuota dan kualitas jawaban model tidak diuji; model/provider pengujian lokal.
- Status izin OS dibaca tanpa meminta atau mengubah izin. Desktop-control MCP eksternal tidak dipasang atau dijalankan.
- Referensi ke berkas pengguna tetap bergantung pada keberadaan sumbernya. Jika sumber dipindah/dihapus, aplikasi meminta pengguna melampirkan ulang; tidak berpura-pura memiliki salinan.
- Log `fix-*.log` dan screenshot `capabilities-fixed.png` menyertai laporan; token server fixture disamarkan dalam salinan log.

Pengujian yang dapat diulang: `npm run build`, `npm test`, `node scripts/verify-ui.mjs`, `node scripts/verify-desktop.mjs`, `node scripts/verify-session-swipe.mjs`, dan `node scripts/verify-workflow-fixes.mjs`.
