# CLAUDE.md

Catatan kerja untuk anticode. Baca README.md untuk arsitektur; berkas ini hanya
memuat aturan yang harus diikuti setiap kali menambah atau mengubah kode.

## Aturan hover: lime adalah satu-satunya aksen

anticode punya satu warna aksen, `--color-brand` (`#d1fa22`, kelas `text-brand`).
Warna itu dipakai untuk menandai **apa yang bisa disentuh kursor**. Aturannya dua
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

## Commit

Pengguna biasanya mengumpulkan beberapa perubahan dulu baru commit sekaligus.
Biarkan working tree kotor kecuali diminta commit.
