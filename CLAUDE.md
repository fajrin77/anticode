# CLAUDE.md

Catatan kerja untuk anticode. Baca README.md untuk arsitektur; berkas ini hanya
memuat aturan yang harus diikuti setiap kali menambah atau mengubah kode.

## Aturan hover: lime adalah satu-satunya aksen

anticode punya satu warna aksen, `--color-brand` (`#d1fa22`, kelas `text-brand`).
Warna itu dipakai untuk menandai **apa yang bisa disentuh kursor**, dan juga
**apa yang sedang menyala** — switch yang aktif memakai `bg-brand`, bukan hijau.
Tidak ada warna aksen kedua: `bg-add`/`text-add` (hijau) hanya untuk statistik
diff dan penanda berhasil, tidak pernah untuk keadaan sebuah kontrol. Aturannya dua
kalimat, dan berlaku untuk setiap kontrol baru tanpa kecuali:

1. **Jika kursor mendekati ikon, ikon berubah jadi lime.**
2. **Jika kursor mendekati tombol berbentuk font, font berubah menjadi lime.**

Artinya setiap `<button>`, tautan, baris daftar yang bisa diklik, dan setiap
disclosure di transkrip harus punya `hover:text-brand` (atau
`group-hover:text-brand`) plus `transition-colors`. Perubahan latar seperti
`hover:bg-raised` boleh tetap ada, tetapi tidak pernah menggantikan aturan ini —
latar saja bukan penanda yang cukup.

### Cara memasangnya

```tsx
// Ikon atau label yang mewarisi warna dari tombolnya:
className="text-dim transition-colors hover:bg-raised hover:text-brand"

// Label yang menetapkan warnanya sendiri tidak akan terkena hover induknya.
// Pasang `group` di tombol dan `group-hover:` di label:
<button className="group …">
  <span className="text-text transition-colors group-hover:text-brand">…</span>
</button>
```

Tab dan tombol ikon di header, composer, dan panel web memakai `glass-ghost`:
saat diam hanya font/ikonnya yang terlihat, kotak glass-nya muncul saat hover.
Jangan kembalikan `glass-control` permanen ke kontrol seperti itu; `glass-control`
hanya untuk keadaan terbuka (misalnya chip yang menunya sedang tampil).
Tab sesi aktif juga memakai `glass-control` dan garis lime sebagai penanda pilihan
yang tetap terlihat; tab sesi tidak aktif tetap `glass-ghost`. Kedua keadaan harus
memiliki border dengan ketebalan sama agar pergantian tab tidak menggeser layout.

Kesalahan yang paling sering: menaruh `hover:text-brand` di tombol padahal isinya
punya `text-text`/`text-dim`/`text-faint` sendiri — hover-nya tidak akan terlihat.
Selalu periksa apakah anak elemennya mewarnai dirinya sendiri.

### Tiga pengecualian, dan hanya tiga

- **Aksi merusak tetap merah.** Hapus sesi dan hapus provider memakai
  `hover:text-del`; merah adalah peringatan, dan lime akan menghilangkannya.
  Tombol `×` yang hanya menutup tab bukan aksi merusak — itu lime.
- **Kontrol yang sudah berlatar lime tetap gelap.** Tombol kirim saat sesi
  di-pause berlatar `bg-brand` dengan teks `text-bg`; lime di atas lime tidak
  terbaca. Yang berubah saat hover cukup latarnya (`hover:bg-brand-strong`).
  Aturan yang sama berlaku untuk isi kontrol, bukan cuma teks: knob switch yang
  menyala memakai `bg-bg`, karena putih di atas lime nyaris tak terlihat.
- **Keadaan aktif memakai warna penuh, bukan hover.** Ikon dashboard dan setting
  yang sedang terbuka sudah `text-brand` permanen; hover tidak menambah apa-apa.

### UI HP (`src/main/remote/public/index.html`)

Layar sentuh tidak punya hover. Padanannya di sana adalah `:active` — kontrol
yang ditekan berubah lime (`#d1fa22`) selama jari menyentuhnya. Aturan yang sama,
kejadian yang berbeda.

### Memeriksa

`npm run test:ui` memuat app sungguhan lewat Playwright dan membandingkan
`getComputedStyle(el).color` dengan `rgb(209, 250, 34)` setelah `.hover()`.
Setiap kontrol baru yang menonjol sebaiknya ikut diperiksa di sana, supaya
aturan ini tidak pelan-pelan luntur.

## Aturan tata letak: memilih tidak boleh menggeser apa pun

Mengklik tab, item menu, switch, atau model tidak boleh membuat kotak, tabel,
atau teks di sekitarnya bergeser walau satu piksel. Keadaan aktif dan tidak
aktif harus berukuran sama persis:

- **Border sama di kedua keadaan.** Kalau yang aktif memakai `glass-control border`,
  yang tidak aktif memakai `border border-transparent` (atau `glass-ghost`, yang
  sudah punya border transparan). Border yang muncul hanya saat aktif menggeser
  isi 1px — itu yang membuat menu terlihat "goyang" dan tidak lurus.
- **Area scroll menyimpan tempat scrollbar-nya.** Container `overflow-y-auto`
  yang isinya bisa pendek atau panjang (halaman Settings, panel) memakai
  `[scrollbar-gutter:stable]`, supaya halaman pendek dan panjang sejajar.
- **Angka dan label yang muncul-hilang tetap memakan tempat.** Hitungan seperti
  "moonshot 1" dirender selalu, `invisible` saat nol, dengan `tabular-nums`;
  jangan pasang `{count > 0 && …}` di dalam tab yang berderet.
- **Switch dan knob-nya di tempat yang sama.** On dan off memakai border yang
  sama, jadi knob tidak melompat 1px saat berganti warna.

Periksa dengan berpindah antar-bagian Settings dan menyalakan/mematikan model:
tidak ada yang boleh bergerak kecuali yang diklik.

## Commit

Pengguna biasanya mengumpulkan beberapa perubahan dulu baru commit sekaligus.
Biarkan working tree kotor kecuali diminta commit.

## Aturan balasan: tidak ada narasi kerja di sesi

Sesi itu untuk percakapan dengan pengguna, bukan jurnal langkah. Jangan tampilkan rencana,
verifikasi, atau status antara ("sekarang mengetik", "typecheck bersih, lanjut test") sebagai
pesan; jalankan saja, maka composer menampilkannya sendiri lewat langkah-tools. Aturan
prompts system juga melarang model membelanjakan turn hanya untuk status: rubah ke
`todo_write` + panggilan kerja nyata di turn yang sama. Pesan terakhir = jawaban akhir,
ringkas, tanpa "sekarang saya...", tanpa sisa kalimat proses.
