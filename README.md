# anticode

Versi **0.0.27** memperhalus swipe antar sesi dari isi chat dan bar tab, menjaga
lampiran serta draft setelah restart, menyediakan Pause saat mengetik, menyimpan
posisi baca, dan mencegah download ganda. Dashboard memakai draft persisten;
status izin computer use, nomor versi, dan penjelasan mode Auto diperjelas.

Versi **0.0.26** merangkum seluruh perubahan setelah 0.0.25: indikator tab aktif,
perpindahan tab dengan swipe dua jari dan pengaturan ulang urutan tab, penyederhanaan
Settings dengan menyembunyikan Credentials dan Pricing, tool screenshot layar penuh,
unduhan lampiran dari HP, izin approval yang tersimpan, perbaikan mode Auto, serta
Reveal in Finder. Alur agent dan penanganan provider juga diperbaiki.

Versi **0.0.25** menambah pencarian isi transkrip sesi, duplikat dan fork sesi, serta preset prompt
di dashboard; setup Rotate usage lebih mudah dan panel plan tetap tersimpan. Koneksi yang putus di
tengah balasan kini berhenti dengan pesan jelas dan tombol Continue, tanpa teks dobel. Approval
mengambang tepat di atas composer dan tidak lagi tertolak oleh Escape saat mengetik. Excel, Word,
dan PDF bisa ditulis ke folder yang belum ada. Tool yang gagal tetap terlihat, error provider tampil
merah (kuota habis menyarankan ganti model), dan footer model/token tidak bergeser setelah pause.
Menambah provider tidak lagi mengganti default, dan `+` dari Settings langsung membuka tab baru.

Versi **0.0.24** menambah tool `share_file` — agent menyerahkan file apa pun (hasil build, keluaran
command) sebagai kartu Preview/Download, dan tidak lagi boleh mengaku file tampil tanpa kartunya.
Pause tidak membuang kerja: balasan yang sedang ditulis disimpan, Resume melanjutkannya. Grup Rotate
usage bisa mengambil satu provider utuh dan diganti langsung dari composer; dropdown model-nya memakai
menu app sendiri. Transkrip tidak lagi berkedip atau bergetar selama run di desktop maupun HP, plan
HP yang panjang tetap di dalam composer, dan workbook besar tetap bisa dilampirkan.

Versi **0.0.22** menambah automatic context compaction, checklist `todo_write`, checkpoint file yang
ikut dipulihkan saat Revert, meter context, enkripsi API key lewat secure storage OS, retry yang
menghormati `Retry-After`, notifikasi sistem, ekspor transcript Markdown/JSON, dan shortcut global
Cmd/Ctrl+Shift+Space.

Versi **0.0.16** membuat berkas bisa dilihat langsung di dalam sesi: klik kartu berkas hasil atau lampiran dan berkas terbuka di viewer — workbook lengkap dengan warnanya, Word sebagai kertas, PowerPoint sebagai teks slide, teks, gambar, dan PDF — di desktop maupun HP, tanpa diunduh dulu. Judul sesi kini ditentukan main process, jadi antichat yang dimulai dari HP tidak lagi bernama "New session" di desktop. Latar HP tidak lagi berpita seperti tangga, dan petunjuk composer HP kembali menjadi "Message…". Versi **0.0.15** membuat antichat bisa mengedit file hanya dengan melampirkannya: setiap sesi antichat punya folder privat di data app, lampiran disalin ke sana, antichat mengeditnya dengan tool dokumen (file, Excel, Word, PDF — tanpa terminal, hapus, atau internet) tanpa meminta approval, dan hasilnya muncul sebagai Download di desktop dan HP; folder itu ikut terhapus bersama sesinya. Di HP, petunjuk composer kini selalu satu baris dan memudar bila tidak muat, dan nama sesi di header tidak lagi tampil dobel. Versi **0.0.14** mengganti contoh teks composer di dashboard, sesi, dan HP menjadi "Don't work today, just vibes." Versi **0.0.13** membuat chrome lebih bersih: tab dan tombol ikon di header serta composer desktop hanya menampilkan font/ikon, kotak glass-nya muncul saat kursor mendekat; di HP hal yang sama berlaku untuk tombol header dan composer (kotak muncul saat disentuh), dan composer HP tidak lagi bergaris lime saat diketik. Header desktop dan HP kini memakai blur bertingkat yang memudar ke bawah tanpa garis tepi, dengan transkrip menggulir di bawahnya. Versi **0.0.12** menyatukan material glassmorphism pada tombol, tab, composer, menu, kartu rute HP, browser, dan Settings desktop; header tab desktop kini memakai blur bergradasi tanpa bilah hitam solid, dan jarak bawah composer desktop kembali ke 24 px. Versi **0.0.11** membuat glassmorphism lebih nyata: composer desktop mengambang langsung di atas transkrip tanpa footer hitam, composer dan header HP lebih transparan, fade nama model berasal dari hurufnya sendiri, serta popup tiga titik menjadi popover glass yang ringkas dan menempel ke tombol. Versi **0.0.10** menyatukan composer desktop dan HP dalam kotak glass yang tumbuh bersama teks, kutipan, gambar, dan berkas terlampir. Header HP kini blur/glass, nama model panjang memudar sebelum memakai lebih dari setengah lebar composer, dan ruang Revert tetap tersedia. Alur Excel juga lengkap: upload desktop/HP masuk ke workspace sesi, `.xlsx`, `.xlsm`, dan `.xls` bisa dibaca, format warna/bold dapat diubah per range, lalu workbook hasil muncul sebagai unduhan. Versi **0.0.9** membawa semua fungsi desktop ke HP: Revert, chip model dan Default/Auto di bawah kolom input, menu Settings, cari sesi, saran folder, dan Back/Forward di layar Web. Rincian pengujian: [laporan QA](docs/QA-2026-09-10.md). Jalankan `npm run test:desktop` untuk smoke test Electron dengan profil sementara dan provider lokal, `npm run test:packaged` untuk memastikan app hasil packaging bisa dibuka dari profil kosong, dan `npm run test:ui` untuk memeriksa state visual header dan popover.

AI coding agent desktop app — provider-agnostic, tool-use loop, berjalan sebagai aplikasi Electron.

Status: **Fase 4 selesai**. Lima provider di belakang satu abstraksi, tool termasuk task tracking, Excel,
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

Tekan **Cmd/Ctrl+Shift+Space** dari aplikasi lain untuk memunculkan anticode.

**Notifikasi.** Settings → General → **Notifications** mengatur semua notifikasi sistem di satu tempat:
saklar induk untuk membisukan semuanya, lalu per jenis — run selesai (nama sesi dan durasinya), run
gagal (beserta error-nya), tool menunggu approval, dan update tersedia — ditambah suara dan "Only when
anticode is in the background" (on). Mengklik notifikasi membuka jendela utama tepat di sesinya, sesi
yang diarsipkan ikut dimunculkan kembali. Pause tidak lagi memicu notifikasi "stopped".

**Menu bar dan quick capture.** anticode memasang ikon di menu bar (tray di Windows/Linux; bisa
dimatikan di Settings → General → Menu bar icon). Menunya berisi **Quick capture…**, **Show anticode**,
enam sesi terakhir (● = sedang bekerja) yang langsung terbuka di jendela utama, dan Quit. Quick capture
— juga lewat **Cmd/Ctrl+Alt+Space** dari aplikasi mana pun — adalah kotak prompt mengambang ala
Spotlight di layar tempat kursor berada: Enter memulai sesi baru di belakang layar tanpa memunculkan
anticode, Cmd/Ctrl+Enter memulai dan membukanya, Tab berpindah antichat/anticode (anticode memakai
folder terakhir yang dipilih di layar Projects), Escape atau klik di luar menutupnya. Approval sesi itu
tetap muncul di jendela utama. Dengan ikon menyala, menutup jendela di Windows/Linux membiarkan
anticode tetap berjalan di tray. Popover usage tiap sesi
menampilkan persentase context terbaru dan menyediakan ekspor transcript lengkap ke Markdown atau JSON.

## Dua mode sesi

| | antichat | anticode |
|---|---|---|
| Folder project | tidak perlu (folder privat per sesi di data app) | wajib |
| Tool | tool dokumen saja — file, Excel, Word, PDF, checklist, `share_file` | kedua puluh tujuh tool |
| Dipakai untuk | tanya jawab, brainstorming | membaca dan mengubah project |

antichat bukan sekadar mode dengan tool yang disembunyikan: daftar tool yang dikirim ke provider
hanya berisi tool dokumen, dan semuanya terkunci di folder privat sesi itu — tanpa terminal, hapus,
browser, internet, maupun MCP — jadi model tidak bisa menyentuh project atau berkas lain di disk.
Karena hanya menyentuh salinannya sendiri, tool itu jalan tanpa approval. Kartu **anticode** di dashboard
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
| OpenAI | `OPENAI_API_KEY` | katalog otomatis |
| Google Gemini | `GOOGLE_API_KEY` | katalog otomatis |
| Ollama (lokal) | tidak perlu; `OLLAMA_BASE_URL` | katalog otomatis |
| Clinepass | `CLINEPASS_API_KEY` + `CLINEPASS_BASE_URL` | `CLINEPASS_MODEL` (opsional) |

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

**Anthropic API dan OpenAI API.** Settings → Providers → Add provider punya dua tipe untuk API resmi
vendor: **Anthropic API** (adapter Messages API bawaan, key `sk-ant-…`) dan **OpenAI API**. Cukup isi
API key; nama dan Base URL (`https://api.anthropic.com`, `https://api.openai.com/v1`) terisi sendiri.
Provider Anthropic mulai di `claude-opus-5` bila tidak ada id model yang diketik, dan permintaan 32K
token output diturunkan otomatis ke batas model yang dilaporkan Models API, supaya model lama tidak
menolaknya. Katalog OpenAI disaring dari model embedding, suara, gambar, dan moderasi. Keduanya bisa
dicentang di Settings → Models dan ikut Rotate usage bersama gateway lain. Login memakai langganan
Claude Pro atau akun ChatGPT sengaja tidak didukung: jalur itu bukan untuk aplikasi pihak ketiga.

Ollama dan Clinepass memakai adapter yang sama dengan OpenAI karena keduanya bicara format
`/v1/chat/completions`. Pergantian provider/model dilakukan di antara run dan mempertahankan
percakapan yang sudah selesai. Adapter menerjemahkan blok pesan sesuai format provider tujuan.

**Model milik tiap sesi.** Model yang dipilih di satu tab hanya berlaku untuk sesi itu; sesi lain
tetap memakai modelnya sendiri, dan run yang sedang berjalan tidak pernah berganti model di tengah
jalan. Pilihan terakhir juga menjadi model awal untuk sesi baru. Pilihan tiap sesi disimpan di
`sessions.json`, jadi tetap sama setelah app dibuka ulang.

**Model di composer.** Di Settings → Models, centang model yang ingin ditawarkan composer (per
provider, termasuk id yang diketik manual). Picker model di composer — desktop maupun HP — lalu hanya
menampilkan model yang dicentang. Provider yang belum punya centang menawarkan nol model, dengan
petunjuk untuk memilihnya di Settings → Models; id yang diketik di kotak pencarian tetap bisa dipakai.

**Rotate usage.** Rotate usage punya switch on/off di Settings → Providers dan mulai dalam keadaan
off. Selama off, **Rotate** tidak ditawarkan di picker dan tidak ada token yang dihitung; mematikannya
memindahkan sesi yang sedang di Rotate ke model terakhir yang dipakainya. Saat on, model yang dicentang
itu menjadi pool Rotate usage (terlihat beserta hitungan tokennya di bawah switch): model-model yang
berbagi beban token — misalnya beberapa akun di gateway yang sama. Sesi yang memilih **Rotate** di
chip modelnya memakai satu model selama **2 prompt**, lalu pindah ke model lain di pool yang tokennya
paling sedikit terpakai; sesi yang mulai bersamaan disebar dulu ke model yang sedang tidak dipakai. Model yang gagal (rate limit,
kuota habis, error) langsung menyerahkan giliran ke model berikutnya tanpa menunggu backoff, lalu
diistirahatkan satu menit. Token dihitung dari semua sesi, termasuk sesi yang memakai model pool
secara tetap; model yang baru masuk pool mulai sejajar dengan yang paling sedikit terpakai, bukan dari
nol.

Model yang kuotanya habis (HTTP 402, `insufficient_quota`, saldo/kredit habis, *usage limit*) diberi
tanda **out of usage** di Settings dan di HP, lengkap dengan tombol **Replace** untuk menukarnya di
tempat. Selama bertanda, model itu hanya dicoba kalau tidak ada model lain yang bisa; tandanya hilang
begitu model itu menjawab lagi atau saat **Reset counts**. Pool juga bisa dibagi ke **grup** bernama
(misalnya "code only", "media only", "reasoning"): tab di atas daftar memilih grup yang dilihat, dan
**Use this group** menjadikannya grup yang dipakai semua sesi. Pergantian grup terjadi di main process,
jadi setiap composer — desktop dan HP — langsung menampilkan `rotate · <grup>` dan prompt berikutnya
pergi ke salah satu model grup itu. Grup hanya berisi model pool: model yang disebut grup ikut masuk
pool, dan model yang keluar dari pool keluar juga dari semua grup. Di HP, grup bisa dipilih dan diisi;
membuat, mengganti nama, dan menghapus grup dilakukan di desktop.

Di HP, swipe ke kanan/kiri berpindah sesi — di judul header maupun di mana saja di area chat.

## Tool dan tier risiko

| Tool | Fungsi | Tier |
|---|---|---|
| `todo_write` | Terbitkan checklist kerja lengkap yang terlihat dan tersimpan di transcript | rendah |
| `task` | Kirim satu pertanyaan ke sub-agent read-only; hanya laporannya yang kembali | rendah |
| `read_file` | Baca berkas dengan nomor baris | rendah — jalan tanpa bertanya |
| `list_directory` | Daftar isi folder | rendah — jalan tanpa bertanya |
| `search_files` | Cari teks di seluruh workspace, per baris | rendah |
| `write_file` | Tulis berkas | sedang — preview diff |
| `edit_file` | Ganti potongan teks unik | sedang — preview diff |
| `run_command` | Jalankan perintah shell | sedang, naik ke tinggi bila destruktif |
| `delete_file` | Hapus berkas atau folder | tinggi — selalu ditanya |
| `read_excel` | Baca sheet .xlsx sebagai tabel, dengan warna fill/font dan bold per range | rendah |
| `create_excel` | Bikin .xlsx baru dari tabel baris | sedang — preview 10 baris pertama |
| `write_excel_cell` | Ubah satu cell | sedang — preview sebelum/sesudah |
| `add_excel_formula` | Pasang formula di satu cell | sedang |
| `format_excel_cells` | Ubah warna latar, warna teks, dan bold pada satu atau beberapa range | sedang — preview sebelum/sesudah |
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

**Panel rencana.** Checklist terakhir dari `todo_write` dipasang di atas kolom input sebagai panel
**Plan 2/5**: terbuka penuh selama run mengerjakannya, terlipat jadi satu baris (item yang sedang
dikerjakan) saat tidak ada run, dan hilang sendiri begitu semua item selesai. Klik judulnya untuk
membuka atau melipat. Item selesai bertanda centang hijau dan dicoret, item aktif berdenyut. Panel
dibaca ulang dari transcript, jadi tetap ada setelah app dibuka ulang, dan HP menampilkan panel yang
sama di atas composer-nya.

**Sub-agent.** `task` menjalankan sesi anak dengan model dan folder yang sama, tetapi riwayatnya
kosong dan tool-nya hanya baca (`read_file`, `list_directory`, `search_files`, `read_excel`,
`read_docx`, `read_pdf`, `fetch_url`) — tanpa edit, terminal, browser, maupun `task` lagi. Yang
kembali ke agent utama hanya laporan akhirnya, jadi berkas yang dibaca sub-agent tidak memenuhi
context utama. Karena `task` terhitung read-only, beberapa `task` dalam satu giliran berjalan
paralel: itulah "parallel Explore". Langkah sub-agent muncul live di baris **Agent** transkrip,
tokennya ikut dihitung di baris penutup run tetapi tidak menggeser meter context, dan ia berhenti
sendiri setelah 30 langkah. antichat tidak ditawari `task`.
Tool browser (navigate, get_text, screenshot, network) berbagi satu halaman Chromium, jadi mereka
diperlakukan serial meski tidak mengubah berkas.

## MCP

Settings → **MCP** menghubungkan server Model Context Protocol, dan tool-nya ikut ditawarkan ke sesi
anticode (antichat tidak pernah mendapatkannya). Server bisa berupa **Command** — proses lokal yang
diajak bicara lewat stdio, misalnya `npx -y @modelcontextprotocol/server-filesystem /path` — atau
**URL** Streamable HTTP dengan header seperti `Authorization: Bearer …`. Blok `mcpServers` dari
konfigurasi klien MCP lain bisa ditempel di **Import**. Environment dan header disegel dengan keychain
OS seperti API key dan tidak pernah dikirim ke jendela; saat mengedit, kunci yang dikosongkan
mempertahankan nilai tersimpan. Karena app yang dibuka dari Dock tidak mewarisi PATH shell, anticode
mengambil PATH dari login shell sekali, jadi `npx`/`uvx`/Homebrew ditemukan.

Server yang menyala dijalankan di latar saat start-up; statusnya (connected · N tools / failed beserta
pesan stderr-nya, dengan **Retry**) terlihat di Settings, dan daftar tool-nya bisa dibuka. Tool
tampil sebagai `mcp__server__tool` ke model, sebagai **MCP** `server · tool` di transkrip, dan
setiap panggilan melewati gerbang approval yang sama dengan tool bawaan: risiko sedang (ditanya, bisa
"Always allow" per tool per sesi), risiko tinggi bila server menandai tool itu `destructiveHint`, dan
tanpa bertanya hanya untuk server yang di-**Trust**. Klien MCP-nya ditulis sendiri tanpa dependensi:
handshake `initialize`, `tools/list` berhalaman, `tools/call` (teks, gambar, resource), `ping`,
pembatalan, dan `notifications/tools/list_changed`.

## Context budget

Riwayat yang diputar ulang ke provider diestimasi per giliran (teks ÷ 4 karakter, gambar dihitung
tetap). Begitu melewati ~100 ribu token, giliran lama diganti memory yang **ditulis model sesi itu
sendiri**: tujuan dan permintaan pengguna, keputusan, berkas, perintah beserta hasilnya, dan keadaan
kerja terakhir; memory sebelumnya ikut dilebur, bukan diulang. Pemotongan hanya terjadi di batas
prompt pengguna, sehingga pasangan `tool_use`/`tool_result` tidak pernah terbelah, dan menyisakan
ruang (~72%) supaya langkah berikutnya tidak memicu kompaksi lagi. Bila provider gagal, lambat
(>2 menit), atau menjawab kosong, ringkasan deterministik lama dipakai — kompaksi tidak pernah
menghentikan run. Transkrip menampilkan baris `context compacted · 104,000 → 38,000 tokens`, token
ringkasan ikut dihitung di baris penutup run, dan transcript asli tidak dipotong. **Compact context**
di popover usage (desktop) dan di Settings HP menjalankan kompaksi yang sama kapan saja di antara run.
Error transien provider (429, 5xx, timeout) diulang otomatis sampai dua kali dengan backoff
eksponensial berjitter dan menghormati header `Retry-After`.

Sebelum sebuah tool mengubah berkas, agent menyimpan before-image-nya sekali per run di
`userData/checkpoints/<sesi>/`, jadi **Revert** tetap mengembalikan berkas setelah app dibuka ulang.
Tool yang menyebut targetnya — `edit_file`, `write_file`, `delete_file` (folder ikut, sampai 5000
berkas), Excel, Word, dan PDF (`path` maupun `output_path`) — disalin tepat sebelum berjalan.
`run_command` tidak menyebut apa pun, jadi workspace dipindai sebelum dan sesudah perintah: berkas
yang dibuat, diubah, atau dihapus terminal ikut tercatat, termasuk folder baru. Before-image perintah
diambil dari mirror yang diperbarui dengan clone copy-on-write (APFS), sehingga project yang tidak
berubah hanya dibayar satu `stat` per berkas. Folder dependensi/build yang sama dengan daftar abaikan
`list_directory` (`node_modules`, `.git`, `dist`, …) tidak dipindai, berkas di atas 20 MB dan
workspace di atas 20.000 berkas dicatat sebagai tidak terlacak. Checkpoint diikat ke prompt yang
memulainya; 40 prompt terakhir disimpan, dan checkpoint ikut terhapus bersama sesinya.

API key yang dimasukkan lewat Settings disimpan dengan Electron `safeStorage` (Keychain di macOS,
DPAPI di Windows) dan file plaintext lama dimigrasikan otomatis. Bila secure storage OS tidak
tersedia, key tidak ditulis ke disk dan perlu dimasukkan kembali setelah app dibuka ulang — Settings →
Providers kini mengatakannya terang-terangan.

Key di `.env` tetap milik pengguna dan tidak pernah diubah diam-diam. Kartu **Credentials** di bawah
Settings → Providers menampilkan variabel rahasia yang dibaca dari file itu (nama yang berakhiran
`API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`) hanya dalam bentuk tersamar (`sk-l…abcd`), mana yang dipakai
anticode, dan apakah akun lain di komputer ini bisa membaca filenya. Dua tindakan eksplisit tersedia:
**Move to secure storage** (dua klik) menyegel key yang dipakai anticode (`CLINEPASS_API_KEY`) ke
keychain lalu mengganti barisnya di `.env` dengan komentar bertanggal — baris lain tidak disentuh, dan
tindakan ini ditolak bila secure storage tidak ada; **Make it readable only by me** menjalankan
`chmod 600` pada file itu. Server MCP menyimpan environment dan header-nya dengan penyegelan yang sama.

## Estimasi biaya

Setiap request diberi harga di main process, jadi desktop dan HP menampilkan angka yang sama: baris
penutup run menulis `~$0.04`, popover usage dan Settings HP menampilkan **Estimated cost** sesi, dan
Settings → **Pricing** menampilkan harga setiap model (per sejuta token input/output) beserta total
belanja per model. Urutan sumber harga: harga yang diketik pengguna di Settings → Pricing, harga yang
dipublikasikan gateway di daftar modelnya (format OpenRouter, `pricing.prompt`/`completion`), lalu
tarif Anthropic bawaan (per 2026-06-24: Fable 5.1/5 $10/$50, Opus 5/4.8/4.7/4.6 $5/$25, Sonnet 5 $2/$10,
Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5; prefiks vendor `anthropic/` dan akhiran tanggal dikenali). Model
berakhiran `:free` bernilai $0. Model yang tidak diketahui harganya **tidak ditebak**: ia dihitung $0
dan estimasinya ditandai `≥`. Estimasi hanya menghitung token input dan output — diskon cache dan
biaya tambahan provider tidak termasuk.

## Update otomatis

Settings → **Updates** memeriksa versi baru dari sumber yang diisi pengguna — belum ada sumber bawaan:

- repository GitHub (`owner/repo` atau URL-nya): release terbaru beserta asetnya;
- URL feed electron-builder (folder-nya atau `latest-mac.yml`/`latest.yml`/`latest-linux.yml`);
- folder lokal berisi build, misalnya `release/` project ini — nama berkas electron-builder
  (`anticode-0.0.24-arm64.dmg`) cukup untuk menemukan versi terbarunya.

**Check automatically** (on) bertanya saat start-up dan tiap enam jam; **Download automatically** (off)
langsung mengunduh build yang lebih baru. Unduhan dicek dengan sha512 bila sumber mencantumkannya dan
dibuang bila tidak cocok. **Memasang tidak pernah terjadi sendiri**: tombol **Restart to update** (dua
klik) menutup app, lalu helper kecil menunggu app benar-benar keluar, mengganti bundle — bundle lama
dikembalikan bila penyalinan gagal — dan membuka versi baru. Karena build ini tidak ditandatangani,
Squirrel/electron-updater tidak dipakai: di macOS dmg di-mount (atau zip dibuka) dan `.app`-nya disalin
dengan `ditto`, di Windows installer NSIS dijalankan senyap, di Linux AppImage diganti. App harus berada
di folder yang bisa ditulis (mis. `/Applications`), dan dev run tidak bisa memasang apa pun.

## Aturan project

Bila workspace punya `AGENTS.md`, `CLAUDE.md`, atau `.anticode.md` (urutan itu), isinya — maksimal
4000 karakter — ditambahkan ke system prompt setiap giliran. Berkas dibaca ulang saat sesi dibuat;
buka tab baru untuk mengambil perubahan.

**Instruksi sendiri.** Settings → General → **Custom instructions** ditambahkan ke system prompt
setiap sesi, antichat maupun anticode, sesudah aturan anticode dan `AGENTS.md` project. Setiap sesi
juga bisa punya instruksinya sendiri lewat **Session instructions** di popover usage tab-nya (label
`set` menandai yang terisi); instruksi sesi dibaca sesudah yang global dan disimpan bersama sesinya.
Keduanya dibaca ulang tiap request, jadi perubahan berlaku mulai langkah berikutnya tanpa membuka tab
baru. Batasnya 8.000 karakter; Cmd/Ctrl+Enter menyimpan.

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

**Steer atau queue.** Selama run bekerja, chip **steer/queue** muncul di baris composer (desktop
dan HP). *steer* adalah perilaku di atas: prompt bergabung ke run yang berjalan. *queue* menahan
prompt sampai run itu **selesai**, lalu mengirimnya sebagai run sendiri — antrean berjalan berurutan.
Enter mengikuti chip; Cmd/Ctrl+Enter melakukan yang sebaliknya tanpa membalik chip. Antrean dipegang
main process, jadi prompt yang diantrekan di HP terlihat di desktop dan sebaliknya, tampil di atas
kolom input sebagai `queued 1`, `queued 2`, …; klik teksnya untuk menariknya kembali ke kolom input,
atau × untuk membuangnya. Run yang di-pause atau gagal tidak menjalankan antrean — antrean menunggu
sampai run berikutnya (misalnya resume) selesai. Prompt antrean yang gagal dimulai kembali ke depan
antrean.

Tombolnya mengikuti isi kolom: kosong saat bekerja berarti **pause** (kotak), ada tulisan berarti
**kirim** (panah), dan saat jeda dengan kolom kosong berarti **resume** (segitiga play, lime). Kolom
kosong tidak pernah bisa mengirim. Desktop dan HP memakai ikon dan kata-kata yang sama, dan warna
badge sesi dipegang main process supaya kedua layar melukis sesi dengan warna yang sama.

Pause juga dipegang main process, bukan oleh masing-masing layar: di-pause di HP bisa di-resume di
desktop dan sebaliknya, dan keduanya menampilkan tombol resume yang sama. Pause hanya berlaku bila
run memang masih berjalan — menekannya setelah run selesai tidak meninggalkan tombol resume di mana
pun. Menutup tab desktop juga menghentikan run lewat pause yang sama. Revert di desktop ikut
menghapus giliran itu dari layar HP.

## Edit dan retry

Setiap prompt yang diketik punya **Edit** saat kursor mendekat (desktop). Dua klik — **Edit**, lalu
**Take back** — mengambil prompt itu kembali beserta semua yang datang sesudahnya: balasan, prompt
berikutnya, ringkasan run, dan perubahan berkas yang dibuat run-run itu (lewat checkpoint, jadi
tetap bekerja setelah app dibuka ulang). Prompt kembali ke kolom input bersama lampirannya, siap
diperbaiki dan dikirim. Instruksi susulan dan resume tidak dihitung sebagai prompt tersendiri;
mereka ikut prompt sebelumnya.

Baris penutup balasan terakhir punya **retry**: jawab ulang prompt yang sama dengan model yang sama,
atau pilih model lain dari yang dicentang di Settings → Models (saat Rotate usage on, pool yang
memilih). Balasan lama dan perubahan berkasnya ditarik dulu, lalu prompt yang sama — lampiran dan
gambar ikut — dikirim sebagai run baru. Retry yang tidak bisa dimulai (provider belum siap) tidak
menyentuh apa pun.

## Lampiran

Klik **+**, seret berkas ke mana saja di area sesi (transkrip, ruang kosong, atau kolom input), atau
tempel tangkapan layar langsung dari clipboard. Gambar yang sudah menempel di atas kolom input bisa
diklik untuk dilihat ukuran penuh sebelum dikirim, sama seperti sesudahnya. Di HP, tombol **+** di
composer membuka pemilih berkas dan mengunggahnya ke Mac. Berkas dirutekan
berdasarkan ekstensi: gambar di-resize ke sisi terpanjang 1568 px lalu dikirim sebagai blok gambar;
xlsx, docx, dan pdf diringkas jadi teks; berkas teks dan kode dibaca apa adanya. Batasnya 100 MB per
berkas dan pratinjau dipotong di 2000 karakter agar tidak menghabiskan konteks.

Di transkrip, lampiran tampil sebagaimana dikirim: gambar sebagai gambar (thumbnail 320 px yang ikut
tersimpan di riwayat sesi, jadi masih terlihat setelah app dibuka ulang), berkas lain sebagai kartu
bernama dan berukuran. Klik untuk membukanya di dalam app: gambar dalam ukuran penuh, berkas lain di
viewer berkas (lihat [Berkas hasil](#berkas-hasil)). Thumbnail-lah satu-satunya salinan; berkas
aslinya tidak dipindahkan ke mana-mana.

Bila berkas kebetulan berada di dalam workspace, path relatifnya ikut diberitahukan ke model supaya
tool bisa membukanya penuh. Berkas dari luar folder — unggahan HP, tangkapan layar yang ditempel, atau
berkas yang diseret dari Downloads — disalin dulu ke `.anticode/uploads/` di folder sesi anticode
itu, lalu model diberi path salinannya. Penyalinan terjadi di main process, di pintu prompt yang sama
untuk desktop dan HP, jadi keduanya mendapat salinan yang sama. Folder itu berisi `.gitignore`
bertanda `*`, sehingga tidak muncul di `git status` project dan aturan git project tidak disentuh.
Berkas yang sama dikirim dua kali memakai salinan pertama; berkas dengan nama sama tetapi isi berbeda
diberi nomor (`Template-2.xlsx`), jadi salinan yang sudah diedit agent tidak pernah tertimpa.
Sandbox workspace tetap satu-satunya pintu akses berkas: `.anticode` yang ternyata symlink ke luar
folder ditolak, dan prompt tetap terkirim dengan berkas yang ditandai di luar jangkauan.

Di antichat, lampiran disalin ke folder privat sesi itu di data app (bukan ke project mana pun).
Model mengedit salinan itu dengan tool dokumen, dan berkas yang ditulisnya muncul sebagai Download;
folder itu ikut terhapus bersama sesinya. Bila salinan gagal dibuat, model diberi tahu bahwa
pratinjau adalah satu-satunya yang ia lihat.

Pratinjau workbook memuat ringkasan format per range (fill, warna teks, bold) di atas barisnya, supaya
permintaan seperti "ubah header biru jadi merah" bisa dijawab tanpa menebak sel mana yang biru. Berkas
Excel 97-2003 (`.xls`) dikonversi di memori saat dibaca sehingga file asli tidak disentuh; hasil edit
baru ditulis sebagai `.xlsx`. Judul sesi antichat diambil dari prompt yang diketik, bukan dari header
lampiran yang dikirim di depannya. Judul itu ditentukan main process dan dikirim ke setiap jendela
desktop dan ke HP begitu prompt pertama masuk riwayat, dari mana pun prompt itu diketik.

## Berkas hasil

Dokumen yang dibuat atau diformat agent — pdf, xlsx, docx, csv, pptx, zip — muncul sebagai kartu di bawah jawaban.
Klik kartunya dan berkas terbuka di viewer di dalam sesi, tanpa diunduh dulu; **Download** di kartu
menyimpan salinan lewat dialog Save, dan **Open in app** di viewer membukanya di aplikasi sistem. Kartu
itu dibaca ulang dari tool call yang berhasil, jadi tetap ada setelah sesi dibuka lagi. Berkas kode
biasa sengaja tidak ikut — tempatnya di diff, bukan di daftar unduhan.

Viewer dirender oleh main process (`src/main/preview.ts`), jadi desktop dan HP menampilkan hal yang
sama: workbook per sheet lengkap dengan fill, warna teks, bold, perataan, border, dan merge (500 baris
dan 60 kolom pertama); CSV sebagai grid; Word sebagai kertas; PowerPoint sebagai teks tiap slide;
teks dan kode apa adanya; gambar dan PDF digambar oleh viewer bawaan. Halaman hasil render tampil di
iframe ber-sandbox, jadi tidak ada script dari berkas yang berjalan.

Dari HP, ketuk kartu yang sama untuk membukanya di layar penuh; **Download** tetap satu ketukan.
Setiap berkas di tab **Files** punya tombol `↓`. Unduhan dan pratinjau diresolusi di dalam folder
sesi, jadi path di luar folder ditolak; lampiran hanya bisa dibuka bila riwayat sesi menyebutnya.

## Approval

- **Rendah** jalan otomatis.
- **Sedang** meminta konfirmasi, dan bisa dilonggarkan lewat "Selalu izinkan sesi ini" per tool atau
  centang "Setujui otomatis risiko sedang".
- **Tinggi** selalu ditanya tiap panggilan selama mode Auto mati. Saat Auto aktif, semua tier
  berjalan tanpa bertanya — penggunanya yang memikul tanggung jawabnya.

Preview yang ditampilkan konkret: diff untuk `write_file` dan `edit_file`, perintah lengkap beserta
cwd dan timeout untuk `run_command`.

**Diff viewer.** Diff di dialog approval dan di transkrip memakai viewer yang sama: nomor baris lama
dan baru, baris hijau/merah, syntax highlighting (JS/TS, Python, Go, Rust, C-family/Java/Kotlin/Swift,
CSS, shell, SQL, YAML/TOML, JSON, Ruby, PHP, HTML/XML — komentar blok dan string multi-baris ikut
terbawa antarbaris), dan pilihan **unified** atau **split** (lama di kiri, baru di kanan, baris yang
diganti bersebelahan). Pilihan itu diingat untuk semua diff. Setiap `edit_file`/`write_file` di
transkrip menampilkan `+N −M`, dan membukanya menampilkan diff lengkap; di baris penutup run, klik
nama berkas untuk melihat semua perubahan run itu pada berkas tersebut. Diff disimpan bersama
transkrip (maksimal 30.000 karakter per perubahan) tetapi tidak pernah dikirim ke model. Warna syntax
sengaja hangat dan redup, supaya tidak tertukar dengan lime maupun hijau/merah diff. Di HP, output
tool edit tampil sebagai diff berwarna.

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

Sudah, otomatis: 185 test mencakup kedua puluh empat tool, penjagaan batas workspace termasuk lolos-symlink,
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

**Fase 5 — Computer use.** Screenshot layar penuh dan kontrol mouse/keyboard OS masih belum diaktifkan; fitur ini perlu desain sandbox/approval terpisah sebelum aman dipakai.

Persistence sesi tersedia sejak 0.0.2: transcript tersimpan di direktori data aplikasi dan dipulihkan saat restart. MCP sudah memiliki client/registry dan cakupan unit test; pekerjaan berikutnya adalah verifikasi end-to-end dengan server MCP nyata serta dokumentasi konfigurasi UI untuk pengguna.
