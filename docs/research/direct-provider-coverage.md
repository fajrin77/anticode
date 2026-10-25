# Cakupan provider langsung setelah 0.0.97

Tidak ada request inference diteruskan ke localhost 9router. Konfigurasi endpoint
dibandingkan dengan registry instalasi 9router; ini bukan bukti inference akun.

## Ditambahkan sebagai API key, bukan OAuth subscription

NVIDIA NIM, Ollama Cloud, xAI, Kimi API (Moonshot), BytePlus ModelArk,
Kimchi, API.airforce, Bazaarlink. Semuanya memakai API upstream OpenAI-compatible,
validasi key melalui `/models`, katalog akun tersimpan dan dapat di-refresh,
secure storage akun yang sama dengan Auth lain, dan adapter chat/tool Anticode.
Tanpa katalog valid login gagal; tidak ada model tiruan atau fallback berbayar.
Rute baru ditandai metered secara konservatif agar tidak masuk routing gratis/langganan.
Trial/kuota gratis dari akun tidak otomatis berarti semua model gratis.
Kimi API **bukan** Kimi Code OAuth; xAI API **bukan** Grok CLI/subscription.
Tidak ada refresh token untuk API key. Koneksi baru selalu dipilih eksplisit.

## Belum didukung: jangan menganggap seluruh screenshot selesai

Qoder, Kiro AI, Kimi Code OAuth, Grok CLI, Xiaomi MiMo, Zed, CodeBuddy CN,
Gemini CLI OAuth, Vertex AI, Gemini API di Auth, Cloudflare, Poolside,
OpenCode Free di Auth, dan Kilo Gateway sebagai rute terpisah belum ditambahkan.
Beberapa rute Gemini/OpenCode/Poolside sudah tersedia lewat konfigurasi Providers,
tetapi bukan implementasi Auth baru dari perubahan ini.

Masing-masing membutuhkan kontrak login/refresh/katalog dan adapter yang cocok:
Kiro memakai AWS eventstream, Zed flow native terenkripsi dan protokol khusus,
Gemini CLI menggunakan OAuth/proyek Cloud Code, Vertex kredensial Google/project,
Cloudflare account ID/token. Tidak dipalsukan sebagai OpenAI API key atau memakai
model default rekaan. Kredensial pengguna/entitlement diperlukan untuk probe nyata.

## Daftar Auth

Area daftar dibatasi 660 px (sekitar sepuluh baris tertutup) dengan scroll internal,
keyboard focus dan label aksesibilitas. Tinggi baris terbuka bisa mengurangi jumlah
yang terlihat; seluruh akun tetap dirender, bukan pagination yang menyembunyikan akun.

## Verifikasi

Fixture memeriksa validasi seluruh rute baru, penolakan key/katalog kosong,
pembatalan dan header ke upstream. Electron memeriksa keberadaan rute dan scroll.
Tidak ada probe akun provider atau benchmark kemampuan coding pada perubahan ini.
