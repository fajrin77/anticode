# anticode

Versi **0.0.9** membawa semua fungsi desktop ke HP: Revert, chip model dan Default/Auto di bawah kolom input, menu Settings (mode approval, model, pemakaian token sesi, tambah/hapus provider), cari sesi, saran folder, dan Back/Forward di layar Web. Versi **0.0.8** menyatukan pause di desktop dan HP lewat main process — di-pause di satu layar bisa di-resume di layar lain, dan pause setelah run selesai tidak meninggalkan tombol resume — serta membuat revert, tutup tab, dan ganti model langsung terlihat di kedua layar. Prompt dari desktop dan HP kini masuk lewat satu pintu di main process, jadi yang dikirim bersamaan bergabung ke satu run; me-refresh HP atau desktop di tengah streaming memulihkan teksnya tepat sekali; dan editor HP menolak menyimpan saat agent sedang bekerja di folder yang sama. Versi **0.0.7** menambah tab dan mode full size pada browser, layar Web HP yang dirender selebar HP, instruksi susulan yang bergabung ke run yang sedang berjalan, drop berkas di seluruh area sesi, warna sesi yang sama di HP dan desktop, serta tombol kirim yang tidak pernah bisa mengirim kolom kosong. Versi **0.0.6** memberi anticode browsernya sendiri: sebuah halaman yang terbuka menggeser transkrip ke kiri dan tampil di panel kanan, dengan ikon yang menyembunyikannya untuk seterusnya di sesi itu, dan layar Web di HP. Versi **0.0.3** memperbaiki sejumlah detail UI/UX (hover ikon dashboard, navigasi keluar dari Settings, Escape pada popover, focus ring). Versi **0.0.2** memperbaiki kontrol run desktop/HP, approval, konteks, browser per sesi, persistence, dan editor remote. Rincian pengujian: [laporan QA](docs/QA-2026-09-10.md). Jalankan `npm run test:desktop` untuk smoke test Electron dengan profil sementara dan provider lokal, `npm run test:packaged` untuk memastikan app hasil packaging bisa dibuka dari profil kosong, dan `npm run test:ui` untuk memeriksa state visual header dan popover.

AI coding agent desktop app — provider-agnostic, tool-use loop, berjalan sebagai aplikasi Electron.

Status: **Fase 4 selesai**. Lima provider di belakang satu abstraksi, dua puluh satu tool termasuk Excel,
Word, PDF, dan browser Playwright, sistem approval berbasis risk tier, serta attachment handler
dengan input gambar.

## Setup

```bash
npm install
```

Salin `.env.example` menjadi `.env` lalu isi provider yang mau dipakai. Provider tanpa kredensial
tetap terlihat di UI tetapi ditandai, dan kolom input dikunci dengan alasan yang jelas.

Jika `npm run dev` gagal dengan `Error: Electron uninstall`, biner Electron belum terunduh saat
postinstall. Jalankan sekali:

```bash
node node_modules/electron/install.js
```

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Dev server + Electron dengan HMR di renderer dan restart otomatis di main |
| `npm test` | Test tool, kebijakan risiko, dan agent loop (Vitest) |
| `npm run typecheck` | Typecheck main/preload/shared dan renderer |
| `npm run build` | Typecheck lalu bundle ke `out/` |
| `npm run pack:mac` / `pack:win` / `pack:linux` | Installer lewat electron-builder ke `release/` |

## Cara pakai

1. Jalankan `npm run dev`.
2. Di dashboard, pilih **antichat** atau **anticode**.
3. Beri instruksi. Di mode anticode, tool berisiko memunculkan dialog konfirmasi.

Dashboard juga menampilkan diagram batang pemakaian token, dipecah per model beserta provider-nya,
dengan segmen terpisah untuk token masuk dan keluar.

## Dua mode sesi

| | antichat | anticode |
|---|---|---|
| Folder project | tidak perlu | wajib |
| Tool | tidak ada sama sekali | kedua puluh satu tool |
| Dipakai untuk | tanya jawab, brainstorming | membaca dan mengubah project |

antichat bukan sekadar mode dengan tool yang disembunyikan: daftar tool yang dikirim ke provider
memang kosong, jadi model tidak punya cara apa pun menyentuh disk. Kartu **anticode** di dashboard
tetap mati sampai sebuah folder dipilih.

Tiap tab punya percakapannya sendiri di main process, terikat pada mode dan folder yang berlaku saat
sesi itu dibuat. Membuka tab Code kedua di folder berbeda tidak mencampur riwayatnya.

## Tampilan

Satu tab bar di atas: ikon kisi membuka layar Projects, tiap tab adalah satu sesi dengan badge
berwarna sesuai project-nya. Layar Projects berisi pencarian sesi, daftar project, dan Settings.

Composer di bawah memuat tombol lampiran, chip model, dan chip mode approval (**Default** menanyakan
setiap perubahan, **Auto** melewati yang berisiko sedang; risiko tinggi tetap ditanya). Tombol kirim
berubah jadi tombol henti selama agent bekerja.

Palet sengaja abu-abu netral tanpa rona biru, tanpa warna aksen selain hijau/merah untuk diff.
Balasan model dirender lewat subset markdown kecil — blok kode berpagar, tabel, judul, butir, kutipan,
tebal, dan kode inline. Parser penuh jauh lebih luas daripada yang benar-benar dikeluarkan model.

## Provider

| Provider | Kredensial | Model |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | default `claude-opus-5` |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` |
| Google Gemini | `GOOGLE_API_KEY` | `GOOGLE_MODEL` |
| Ollama (lokal) | tidak perlu; `OLLAMA_BASE_URL` | `OLLAMA_MODEL` |
| Clinepass | `CLINEPASS_API_KEY` + `CLINEPASS_BASE_URL` | `CLINEPASS_MODEL` |

Nama model tidak perlu dihafal: begitu sebuah provider punya kredensial, app menanyakan katalognya
lewat endpoint model milik provider itu sendiri, lalu menampilkannya sebagai daftar yang bisa dicari
di chip model. Klik chip untuk berpindah provider sekaligus memilih model.

Model dipilih otomatis hanya bila katalognya pendek (≤ 25), yaitu daftar milik akun itu sendiri.
Katalog panjang berarti marketplace berisi ratusan model, dan memilih yang pertama secara alfabet di
sana akan mendarat pada model berbayar yang acak — jadi pilihannya diserahkan ke pengguna.

Clinepass adalah gateway agregator: base URL `https://api.cline.bot/api/v1`, id model berbentuk
`vendor/model` (mis. `anthropic/claude-opus-5`, `thinkingmachines/inkling-small:free`), dan
`GET /models` mengembalikan ratusan pilihan. Beberapa model berakhiran `:free` bisa dipakai tanpa
saldo.

**Model langganan Clinepass tidak bisa ditemukan otomatis.** Id berprefiks `cline-pass/` berfungsi
saat dipanggil, tetapi tidak satu pun muncul di `GET /models`; `users/me` tidak memuat informasi
paket, dan `plans` hanya menyebut nama pemasarannya ("Kimi K3, GLM 5.2, …") tanpa id. Jadi untuk
model langganan, isi `CLINEPASS_MODEL` sekali di `.env`, atau ketik id-nya di kolom pencarian pemilih
model dan tekan Enter.

Satu keanehan lain yang perlu diingat kalau nanti menambah jalur non-streaming: respons non-streaming
dibungkus envelope `{"data": {...}}`, sedangkan chunk streaming-nya justru bentuk OpenAI standar.
Adapter ini memakai streaming, jadi tidak terpengaruh.

Ollama dan Clinepass memakai adapter yang sama dengan OpenAI karena keduanya bicara format
`/v1/chat/completions`. Pergantian provider/model dilakukan di antara run dan mempertahankan
percakapan yang sudah selesai. Adapter menerjemahkan blok pesan sesuai format provider tujuan.

## Tool dan tier risiko

| Tool | Fungsi | Tier |
|---|---|---|
| `read_file` | Baca berkas dengan nomor baris | rendah — jalan tanpa bertanya |
| `list_directory` | Daftar isi folder | rendah — jalan tanpa bertanya |
| `search_files` | Cari teks di seluruh workspace, per baris | rendah |
| `write_file` | Tulis berkas | sedang — preview diff |
| `edit_file` | Ganti potongan teks unik | sedang — preview diff |
| `run_command` | Jalankan perintah shell | sedang, naik ke tinggi bila destruktif |
| `delete_file` | Hapus berkas atau folder | tinggi — selalu ditanya |
| `read_excel` | Baca sheet .xlsx sebagai tabel | rendah |
| `create_excel` | Bikin .xlsx baru dari tabel baris | sedang — preview 10 baris pertama |
| `write_excel_cell` | Ubah satu cell | sedang — preview sebelum/sesudah |
| `add_excel_formula` | Pasang formula di satu cell | sedang |
| `read_docx` | Baca .docx sebagai markdown | rendah |
| `write_docx` | Tulis .docx dari markdown sederhana | sedang |
| `read_pdf` | Ekstrak teks dan jumlah halaman | rendah |
| `create_pdf` | Bikin PDF baru dari markdown sederhana | sedang — preview isi |
| `fill_pdf_form` | Isi field form PDF | sedang — daftar field bila kosong |
| `fetch_url` | Ambil isi URL lewat HTTP biasa | rendah |
| `browser_navigate` | Buka halaman di Chromium headless | rendah |
| `browser_get_text` | Ambil teks halaman atau selector | rendah |
| `browser_screenshot` | Tangkap layar halaman sebagai gambar | rendah |
| `browser_click` | Klik elemen | sedang |
| `browser_fill` | Isi input | sedang |
| `read_network_requests` | Daftar request sejak navigasi terakhir | rendah |

Tool read-only dieksekusi paralel dalam satu giliran; tool yang mengubah dijalankan berurutan.
Tool browser (navigate, get_text, screenshot, network) berbagi satu halaman Chromium, jadi mereka
diperlakukan serial meski tidak mengubah berkas.

## Context budget

Riwayat yang diputar ulang ke provider diestimasi per giliran (teks ÷ 4 karakter, gambar dihitung
tetap). Begitu melewati ~100 ribu token, giliran prompt tertua dibuang sampai muat — hanya di batas
prompt pengguna, sehingga pasangan `tool_use`/`tool_result` tidak pernah terbelah. Error transien
provider (429, 5xx, timeout) diulang otomatis sampai dua kali dengan backoff eksponensial.

## Aturan project

Bila workspace punya `AGENTS.md`, `CLAUDE.md`, atau `.anticode.md` (urutan itu), isinya — maksimal
4000 karakter — ditambahkan ke system prompt setiap giliran. Berkas dibaca ulang saat sesi dibuat;
buka tab baru untuk mengambil perubahan.

`list_directory` dan `search_files` melewati folder dependensi dan cache (`node_modules`, `.git`,
`dist`, dan kawan-kawannya) serta melaporkan berapa banyak yang diabaikan, supaya context tidak
banjir derau. Folder ambigu seperti `build` dan `out` sengaja tidak diabaikan.

## Warna dan interaksi

Satu aksen saja: lime `#d1fa22` (`text-brand`). Warna itu menandai apa yang bisa disentuh kursor —
setiap ikon dan setiap tombol berbentuk teks berubah lime saat didekati. Aturan lengkapnya, termasuk
tiga pengecualian (aksi merusak tetap merah, kontrol yang sudah berlatar lime tetap gelap, keadaan
aktif memakai warna penuh) ada di [CLAUDE.md](CLAUDE.md), dan dijaga oleh sapuan hover di
`npm run test:ui`.

## Instruksi susulan

Prompt yang dikirim saat sesi sedang bekerja tidak ditolak dan tidak memulai run kedua: ia bergabung
ke run yang berjalan. Gelembungnya langsung tampil bersama baris "wait a minutes, bi***", tulisan yang
sedang dibuat model tetap di atasnya, dan pada langkah berikutnya (setelah tool yang berjalan kembali,
atau begitu balasan terakhir selesai) run membaca instruksi itu sebagai tambahan tugas lalu lanjut
mengerjakan keduanya. Satu run, satu baris penutup. Kalau di-pause sebelum sempat dibaca, instruksinya
tetap tersimpan di riwayat untuk resume.

Tombolnya mengikuti isi kolom: kosong saat bekerja berarti **pause** (kotak), ada tulisan berarti
**kirim** (panah), dan saat jeda dengan kolom kosong berarti **resume** (segitiga play, lime). Kolom
kosong tidak pernah bisa mengirim. Desktop dan HP memakai ikon dan kata-kata yang sama, dan warna
badge sesi dipegang main process supaya kedua layar melukis sesi dengan warna yang sama.

Pause juga dipegang main process, bukan oleh masing-masing layar: di-pause di HP bisa di-resume di
desktop dan sebaliknya, dan keduanya menampilkan tombol resume yang sama. Pause hanya berlaku bila
run memang masih berjalan — menekannya setelah run selesai tidak meninggalkan tombol resume di mana
pun. Menutup tab desktop juga menghentikan run lewat pause yang sama. Revert di desktop ikut
menghapus giliran itu dari layar HP.

## Lampiran

Klik **+**, seret berkas ke mana saja di area sesi (transkrip, ruang kosong, atau kolom input), atau
tempel tangkapan layar langsung dari clipboard. Gambar yang sudah menempel di atas kolom input bisa
diklik untuk dilihat ukuran penuh sebelum dikirim, sama seperti sesudahnya. Di HP, tombol **+** di
composer membuka pemilih berkas dan mengunggahnya ke Mac. Berkas dirutekan
berdasarkan ekstensi: gambar di-resize ke sisi terpanjang 1568 px lalu dikirim sebagai blok gambar;
xlsx, docx, dan pdf diringkas jadi teks; berkas teks dan kode dibaca apa adanya. Batasnya 20 MB per
berkas dan pratinjau dipotong di 2000 karakter agar tidak menghabiskan konteks.

Di transkrip, lampiran tampil sebagaimana dikirim: gambar sebagai gambar (thumbnail 320 px yang ikut
tersimpan di riwayat sesi, jadi masih terlihat setelah app dibuka ulang), berkas lain sebagai kartu
bernama dan berukuran. Klik untuk membukanya di aplikasi bawaan sistem. Thumbnail-lah satu-satunya
salinan; berkas aslinya tidak dipindahkan ke mana-mana.

Bila berkas kebetulan berada di dalam workspace, path relatifnya ikut diberitahukan ke model supaya
tool bisa membukanya penuh; bila di luar, model diberi tahu bahwa tool tidak bisa menjangkaunya. Ini
menjaga sandbox workspace tetap satu-satunya pintu akses berkas.

## Berkas hasil

Dokumen yang dibuat agent — pdf, xlsx, docx, csv, pptx, zip — muncul sebagai kartu di bawah jawaban,
dengan **Open** (buka di aplikasi sistem) dan **Download** (simpan salinan lewat dialog Save). Kartu
itu dibaca ulang dari tool call yang berhasil, jadi tetap ada setelah sesi dibuka lagi. Berkas kode
biasa sengaja tidak ikut — tempatnya di diff, bukan di daftar unduhan.

Dari HP, kartu yang sama menyediakan tautan unduh, dan setiap berkas di tab **Files** punya tombol
`↓`. Unduhan diresolusi di dalam folder sesi, jadi path di luar folder ditolak.

## Approval

- **Rendah** jalan otomatis.
- **Sedang** meminta konfirmasi, dan bisa dilonggarkan lewat "Selalu izinkan sesi ini" per tool atau
  centang "Setujui otomatis risiko sedang".
- **Tinggi** selalu ditanya tiap panggilan selama mode Auto mati. Saat Auto aktif, semua tier
  berjalan tanpa bertanya — penggunanya yang memikul tanggung jawabnya.

Preview yang ditampilkan konkret: diff berwarna untuk `write_file` dan `edit_file`, perintah lengkap
beserta cwd dan timeout untuk `run_command`.

Deteksi perintah destruktif (`rm -rf`, `sudo`, `git push --force`, pipe ke shell, dan sejenisnya)
adalah heuristik, **bukan batas keamanan**. Cocok berarti wajib approval tiap panggilan; tidak cocok
tetap berada di tier sedang yang minimal ditanya sekali. Jangan pernah membacanya sebagai bukti bahwa
sebuah perintah aman.

## Struktur

```
src/
├── main/              Node.js — semua logika agent ada di sini
│   ├── agent/loop.ts  Agent loop: request → approval → tool → hasil → ulangi
│   ├── providers/     Abstraksi LLM + adapter Anthropic, OpenAI-compatible, Gemini
│   ├── approval/      Tier risiko, kebijakan sesi, dan jembatan dialog
│   ├── tools/         Satu modul per tool, skema Zod, penjaga batas workspace
│   ├── web.ts         Halaman yang dibuka tiap sesi, untuk panel browser
│   └── ipc/           Registrasi handler ipcMain
├── preload/           contextBridge — satu-satunya jembatan renderer ke main
├── shared/ipc.ts      Kontrak tunggal antar-proses
└── renderer/          React + Tailwind, tanpa akses Node
```

## Browser

Tool browser memakai Chromium headless dengan context dan halaman terpisah per sesi, sehingga
navigasi pada satu sesi tidak mengganti halaman sesi lain. Chromium-nya diunduh terpisah:

```bash
npx playwright install chromium
```

Tanpa itu `browser_navigate` gagal dengan pesan yang menyebutkan perintah di atas. `fetch_url` tetap
jalan karena memakai HTTP biasa tanpa browser.

### Panel browser di sebelah transkrip

anticode punya browser sendiri. Begitu sebuah halaman terbuka di satu sesi, transkrip bergeser ke
kiri dan halaman itu tampil di panel kanan — keduanya tetap terpakai sekaligus. Panelnya bisa
ditarik lebarnya, punya tab, address bar sendiri, dan tombol back/forward/reload. Tombol
**full size** membuat panel mengisi seluruh jendela anticode; tombol yang sama mengecilkannya
kembali ke samping, dan transkrip muncul lagi persis di tempat ditinggalkan.

Tab di belakang tetap hidup, tidak dimuat ulang saat dipindah. Agent mengemudikan satu halaman per
sesi, jadi yang dibukanya selalu masuk ke tab aktif; tab lain milik pengguna. Menutup tab terakhir
menyembunyikan panel, bukan melupakannya.
Pembaruan judul atau navigasi dari tab di belakang tidak memindahkan tab aktif ataupun membuka
panel yang sedang disembunyikan. Ikon Web desktop dan pilihan Web HP tidak memakai dot lime.

Ada tiga cara sebuah halaman sampai ke sana:

- `browser_navigate` (dan `browser_click` yang berpindah halaman) melapor ke panel.
- `run_command` yang menyalakan dev server: baris `Local: http://localhost:5173/` di outputnya
  dibaca, jadi `npm run dev` membuka panelnya sendiri tanpa diminta.
- Diketik langsung di address bar panel — `localhost:5173` cukup, skemanya diisikan.

Ikon browser di kanan tab bar menyalakan dan mematikan panel. **Sekali disembunyikan, sesi itu tetap
sembunyi**: halaman baru yang dibuka agent hanya memperbarui isinya diam-diam, tidak memaksa panel
muncul lagi. Hanya ikon itu yang mengembalikannya.

Daftar tab, tab aktif, dan ukuran penuh ikut tersimpan: menutup lalu membuka lagi app
mengembalikan sesi ke halaman yang terakhir dilihatnya. Panelnya `<webview>` Electron — tanpa
preload, tanpa Node, hanya http/https — jadi ia browser sungguhan, bukan tangkapan layar.

## Remote (HP)

Settings → Remote mengaktifkan server HTTP di Mac (port 8680). Buka URL pairing-nya di browser HP
lewat Wi-Fi yang sama, lalu "Add to Home Screen" agar terlihat seperti app. Fitur: daftar session,
chat dengan agent (live streaming), editor file workspace lengkap dengan git commit/push — edit repo
yang terhubung langsung dari HP — dan layar **Web**, di dropdown antara Sessions dan Files.

Apa yang bisa dilakukan desktop, bisa dilakukan HP. Di bawah kolom input ada baris chip yang sama
dengan composer desktop: model, **Default/Auto**, dan **Revert** saat sesi di-pause. Menu
**Settings** membuka panel dari bawah tanpa meninggalkan chat. Isinya mode approval, pilihan
provider dan model, pemakaian token sesi yang terbuka, serta tambah dan hapus provider. Daftar
Sessions punya kolom cari, kolom folder sesi baru menawarkan folder yang sudah dipakai, dan layar Web
punya Back/Forward. Semua lewat main process, jadi apa yang diubah di HP langsung terlihat di
desktop, dan sebaliknya. Yang sengaja tidak ada di HP: menyalakan/mematikan remote dan membuat
ulang link pairing (keduanya akan memutus HP itu sendiri), serta mode full size browser (HP sudah
selalu penuh).

Layar Web menampilkan halaman tab aktif sesi, dirender di Mac sebagai gambar, bukan `<webview>`:
setiap `localhost` yang dilayani ada di Mac, tidak terjangkau dari HP. Gambarnya diambil dari
halaman berukuran HP tersendiri (390 px, user agent iPhone), bukan dari halaman agent — jadi situs
memakai tata letak mobile-nya sendiri, seluruh tingginya ikut, dan HP tinggal menggulirnya dari
tepi ke tepi layar. Halaman agent tidak pernah diubah ukurannya. Tab tampil sebagai chip yang bisa
dipilih, ditutup, dan ditambah. Tombol Hide-nya sama stickynya dengan yang di desktop, dan
keputusannya dibagi — disembunyikan di HP berarti tersembunyi juga di samping transkrip.
Pratinjau HP berupa gambar yang bisa di-scroll; tautan dan formulir di dalam gambar belum bisa
dioperasikan. Tekan Reload untuk memperbarui isi halaman. Tinggi gambar dibatasi 12.000 piksel
(sekitar 6.000 piksel tampilan pada lebar 390 px).

Laptop yang ditutup lidah-nya akan sleep dan remote mati: colok charger + aktifkan "Prevent
automatic sleeping when the display is off", atau jalankan `caffeinate -s`. Di luar rumah, pakai
Tailscale di kedua perangkat. Prompt remote mengikuti mode approval desktop — nyalakan Auto di
General untuk kerja tanpa pengawasan.

## Postur keamanan

- `contextIsolation: true`, `nodeIntegration: false` — renderer tidak punya akses Node.
- `sandbox: false` diperlukan karena preload di-build sebagai ESM; isolasi renderer tidak terpengaruh.
- CSP di-inject saat build saja. `connect-src 'self'` disengaja: panggilan ke provider hanya boleh
  terjadi di main process.
- Setiap path dari model di-resolve terhadap root workspace dan ditolak bila keluar dari sana.
  Pemeriksaan diulang setelah resolusi symlink, sehingga tautan di dalam workspace tidak bisa dipakai
  menjangkau berkas di luarnya.
- Membatalkan run saat dialog approval terbuka otomatis menolak permintaan itu.

## Catatan desain

**Blok `opaque`.** Anthropic mengembalikan thinking block bertanda tangan yang harus dikirim balik apa
adanya. Tipe internal menyimpannya sebagai blok `opaque` bertanda nama provider; blok milik provider
lain dibuang alih-alih diterjemahkan.

**Satu tool result, dua bentuk pesan.** Anthropic mengelompokkan semua hasil tool dalam satu pesan
user; OpenAI menuntut satu pesan `role: "tool"` per hasil. Pemecahan itu tugas adapter, bukan loop.

**Gemini tidak punya id tool call yang dijamin ada.** Adapter menyintesis id bila kosong, menandainya,
dan tidak mengirimkan id sintetis itu kembali. Nama fungsi untuk `functionResponse` diambil dari
panggilan aslinya di riwayat.

**Validasi sekali di depan.** `prepare()` memvalidasi input model lalu mengembalikan tier risiko,
preview, dan eksekusi. Preview hanya dihitung saat approval memang dibutuhkan, jadi panggilan yang
otomatis disetujui tidak ikut membaca berkas.

**Skema tool dibuat dalam mode `input`.** Zod secara bawaan menganggap field ber-`default` selalu ada,
sehingga ikut masuk ke `required` dan model dipaksa mengisinya. `io: 'input'` memperbaikinya, dan key
`$schema` dibuang karena provider menolak key asing.

**Perbaikan history setelah pembatalan.** Giliran yang dibatalkan bisa meninggalkan `tool_use` tanpa
`tool_result`, dan provider menolak history seperti itu di request berikutnya — artinya sesi rusak
permanen, bukan cuma giliran itu.

**Pemilihan provider dihitung malas.** Modul runtime di-import sebelum `loadEnvFile()` sempat jalan,
jadi membaca kredensial di level modul selalu melihat environment kosong dan jatuh ke provider
bawaan. Nilainya baru dihitung saat pertama diakses.

**Escape markdown dari docx dibersihkan.** Mammoth mengembalikan prosa biasa sebagai `paragraf\.`.
Escape itu hanya berguna kalau markdown-nya dirender ulang; di sini teksnya dibaca model, jadi
backslash-nya cuma derau dan dibuang.

**Gambar hasil tool menumpang giliran yang sama, bukan hasil tool-nya.** Anthropic mengizinkan blok
gambar di dalam `tool_result`, tetapi pesan `role: "tool"` milik OpenAI hanya menerima teks. Jadi
`browser_screenshot` mengembalikan teks sebagai hasil tool, sementara gambarnya ditempelkan ke pesan
user yang sama — bentuk yang sah di ketiga provider.

**Ada-tidaknya kredensial memilih provider, bukan ada-tidaknya nama model.** Sebelumnya provider
tanpa nama model dilewati saat pemilihan awal, sehingga memasukkan kunci saja tidak cukup. Ollama juga
dipisahkan: ia tidak butuh kunci sehingga selalu "tersedia", tapi hanya dihitung terkonfigurasi bila
endpoint-nya benar-benar diisi — kalau tidak, ia akan memenangkan pemilihan otomatis dari setiap
provider lain yang justru punya kunci.

**Pemakaian token diatribusikan di main process.** Event usage membawa nama provider dan model dari
adapter yang benar-benar mengerjakan panggilan itu, bukan dari provider yang kebetulan aktif di UI.
Berganti model di tengah sesi karena itu tidak mengacaukan grafiknya.

**Palet grafik divalidasi, bukan dikira-kira.** Dua warna kategorikal pada diagram token lolos
pemeriksaan lightness, chroma, keterpisahan buta warna (deutan ΔE 15.7), keterpisahan penglihatan
normal (ΔE 23.3), dan kontras terhadap latar gelap. Jangan menggesernya dengan mata.

**Gambar dikompresi sebelum dikirim.** Sisi terpanjang dipotong ke 1568 px — di atas itu token
bertambah tanpa menambah ketelitian. PNG hanya dipakai bila gambar punya alpha; selebihnya JPEG,
yang jauh lebih kecil.

## Yang sudah dan belum diuji

Sudah, otomatis: 122 test mencakup kedua puluh tool, penjagaan batas workspace termasuk lolos-symlink,
pembuatan skema, deteksi perintah destruktif, aturan tier risiko, attachment handler (kompresi
gambar, transparansi, batas ukuran, berkas di luar workspace), tool browser terhadap server HTTP
lokal (navigasi, ekstraksi teks, klik, isi form, catatan network, screenshot), serta agent loop lewat provider
tiruan — tool call paralel, kegagalan tool sebagai `tool_result`, penolakan approval, pembatalan, dan
perbaikan history.

Sudah, manual lewat server stub OpenAI-compatible lokal: argumen tool call yang datang
terpotong-potong, pergantian provider di UI, dan penolakan perintah destruktif risiko tinggi.

Sudah, manual lewat API Clinepass sungguhan:

- Tugas shell multi-giliran sampai selesai, dengan approval dan "Selalu izinkan sesi ini".
- Tugas debugging: agent menjalankan test yang gagal, membaca dua berkas, menemukan bug off-by-one,
  menyunting kode lewat preview diff, lalu menjalankan test lagi sampai ketiganya lulus.
- Tugas Excel: membaca workbook lalu memasang header dan tiga formula `=Bn*Cn`; isi berkasnya
  diperiksa ulang di luar app dan formulanya memang tersimpan.
- Lampiran gambar: PNG dilampirkan lewat pemilih berkas, dan model menyebutkan ketiga baris teks di
  dalamnya dengan tepat.

Belum: panggilan sungguhan ke API Anthropic dan Gemini, karena tidak ada kredensialnya di mesin
pengembangan. Kedua adapter itu divalidasi lewat tipe resmi SDK-nya, bukan request nyata. Tool docx
dan PDF baru diuji lewat test otomatis, belum lewat sesi agent sungguhan.

## Catatan dependensi

`npm audit` melaporkan `uuid` lama yang ditarik `exceljs`. Kerentanannya ada di jalur v3/v5/v6 saat
buffer disediakan sendiri; exceljs memakai v4, jadi jalur itu tidak tersentuh. `npm audit fix --force`
akan menurunkan exceljs ke 3.x yang breaking, jadi sengaja tidak dilakukan.

## Fase berikutnya

**Fase 5 — Computer use.** Screenshot layar penuh dan kontrol mouse/keyboard, dijalankan terisolasi.

Persistence sesi tersedia sejak 0.0.2: transcript tersimpan di direktori data aplikasi dan dipulihkan saat restart. Integrasi MCP masih menjadi pekerjaan berikutnya.
