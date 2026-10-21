# Audit efisiensi token dari screenshot Usage

## Lingkup dan batas bukti

Audit read-only terhadap implementasi dan angka pada screenshot rentang 7D.
Tidak menjalankan request provider, membaca kredensial, atau menjalankan benchmark
kemampuan coding. Angka bukan rekonsiliasi invoice. Tidak mengubah rute akun,
model, batas subscription, atau fallback berbayar.

## Angka yang terlihat

| Metrik | Nilai |
| --- | ---: |
| Request | 836 |
| Input | 30.411.028 |
| Cache | 18.483.328 |
| Output | 660.455 |
| Estimasi biaya parsial | sekitar USD 1,15 |
| Rata-rata input/request | 36.377 |
| Rata-rata output/request | 790 |
| Cache/input | 60,78% |
| Input/output | 46,05 kali |

Request mencakup langkah agent, bukan hanya pesan pengguna. Input dapat dikirim
ulang setiap langkah dengan history dan hasil tool. Rasio input/output tinggi
tidak dengan sendirinya membuktikan pemborosan.

Pada protokol yang memasukkan cache sebagai subset input, selisihnya adalah
11.927.700 token, atau sekitar 14.268/request. Jangan menganggap pengurangan
tersebut tepat untuk semua provider: semantik usage antaradapter berbeda.
Cache juga tidak selalu gratis dan tidak membuktikan quota subscription yang
masih tersedia.

UI secara eksplisit menyebut estimasi biaya parsial, termasuk penggunaan tanpa
harga dan subscription. USD 1,15 bukan total biaya ekonomis termasuk langganan.
Baris model bernama sama belum tentu duplikasi request: tabel membedakan
providerId dan model, tetapi nama provider tidak ditampilkan di kolom model.

## Temuan implementasi

- `src/shared/ipc.ts`, `historyBudgetFor` dan `contextWindowFor`: batas history
  mengikuti ukuran context model, bukan target hemat biaya. Fallback context
  180.000 token; model yang dikenal dapat mempunyai batas lebih besar.
- `src/main/agent/loop.ts`, `compactHistory`: pruning mulai di atas 85% budget.
  Hasil tool lama yang melebihi 600 karakter di-stub, dengan empat turn terbaru
  dipertahankan. Di bawah ambang itu hasil tool lama tetap dapat dikirim ulang.
- `src/main/agent/loop.ts`, `MAX_TOOL_OUTPUT`: satu output tool dibatasi 24.000
  karakter. Ini pembatas output individual, bukan total konteks satu langkah.
- `src/renderer/src/components/settings/Usage.tsx`: tabel menggunakan key
  providerId/model dan menampilkan peringatan estimasi biaya parsial.
- `src/main/providers/responses.ts` dan `openai.ts`: cache diambil dari detail
  token prompt/input provider. `anthropic.ts` memakai counter cache terpisah;
  jangan menginterpretasikan agregat lintas provider sebagai invoice seragam.

## Kesimpulan dan prioritas

Pemakaian ini masuk akal untuk agent coding multi-step, tetapi efisiensinya
belum dapat dipastikan tanpa jumlah task yang berhasil, retry, durasi, dan
biaya langganan. Angka screenshot tidak menunjukkan bahwa semuanya mahal.

Langkah tanpa perubahan implementasi:

1. Mulai sesi baru ketika pindah tugas yang tidak berkaitan; jangan kehilangan
   konteks di tengah debugging yang masih membutuhkan history.
2. Cari simbol sebelum membaca file; batasi range bacaan, log, dan output tes.
3. Jalankan aksi independen secara paralel dan jangan mengulang pemeriksaan
   berhasil tanpa perubahan relevan. Tujuannya mengurangi putaran agent.
4. Pilih model subscription/gratis yang sudah terhubung dan memadai untuk tugas
   sederhana; gunakan model lebih kuat saat kompleksitas atau kegagalan
   membutuhkannya. Tidak ada fallback otomatis ke jalur berbayar.

Kandidat perbaikan aplikasi, belum diimplementasikan:

1. Opsi budget konteks hemat yang terpisah dari kapasitas maksimum model.
2. Pruning hasil tool lama lebih awal, dengan perlindungan hasil terbaru dan
   kemampuan membaca ulang sumber; ukur risiko hilangnya informasi.
3. Tampilkan provider pada tabel usage dan pisahkan cakupan token berharga,
   subscription, serta tanpa harga.
4. Evaluasi caching sesuai protokol/provider; jangan menambahkan flag cache
   generik atau menjanjikan penghematan sebelum probe terkontrol.

Ukur perbandingan pada tugas coding setara: tingkat keberhasilan, jumlah
request, input non-cache dengan semantik yang benar, cache, output, durasi,
dan biaya yang benar-benar diketahui. Tidak ada persentase penghematan yang
dapat dijamin hanya dari screenshot ini.
