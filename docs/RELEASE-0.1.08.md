# Perbaikan 0.1.08

- Tombol tambah tab berada di luar strip yang dapat digulir, di sebelah tombol browser. Judul tetap tampil sampai sepuluh tab; sebelas atau lebih memakai ikon.
- Skrip publikasi menyesuaikan nama artefak builder yang dinormalisasi (`0.1.8`) ke versi publik (`0.1.08`), termasuk referensi feed, tanpa mengubah isi arsip atau checksum.
- HTTP 413 dipulihkan maksimal sekali per rute dalam sesi: replay menghilangkan gambar historis, atau meringkas teks secara lokal jika tidak ada gambar historis yang bisa dikecilkan. Lampiran terbaru, identitas tool, dan transkrip asli dipertahankan. Jika tetap terlalu besar, request dihentikan dengan petunjuk yang jelas, bukan loop Continue.
- HTTP 403 diberi petunjuk pemeriksaan akses/endpoint. Penolakan model generik tidak diulang untuk melewati pembatasan. Batas subscription/gratis dan pilihan routing tetap berlaku; tidak ditambahkan fallback berbayar.

Verifikasi memakai fixture provider, unit test, serta Electron terisolasi. Tidak ada probe provider nyata atau klaim bahwa izin akun upstream telah diperbaiki. Penolakan 403 dan batas ukuran provider masih dapat terjadi karena kebijakan upstream atau lampiran terbaru yang terlalu besar.
