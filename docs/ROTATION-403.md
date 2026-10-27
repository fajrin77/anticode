# Rotasi setelah penolakan inference 403

Ketika Rotate aktif, respons inference HTTP 403 tanpa output dapat melewati rute tersebut ke anggota pool/group pengguna berikutnya yang memenuhi syarat. Set rute yang sudah dicoba membatasi setiap rute menjadi satu percobaan dalam satu handover. Cooldown berlaku pada rute yang ditolak, bukan menganggap semua kuota akun habis.

403 tidak selalu berarti kuota habis. Penolakan bukan gangguan sementara dan tidak memicu retry berulang pada rute yang sama. Pilihan subscription-only/gratis, batas keamanan subscription, group aktif, serta pemeriksaan kapabilitas tetap berlaku. Kegagalan pemeriksaan keamanan subscription bukan penolakan inference yang boleh dilewati oleh aturan ini.

Pengujian menggunakan fixture: handover 403 sebelum output, anggota pool subscription yang tepat, berhenti setelah pool habis tanpa masuk ke API metered, dan tetap tidak melakukan retry generik 403. Tidak ada probe provider nyata atau klaim perbaikan izin upstream.
