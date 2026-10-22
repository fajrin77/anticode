# Pemulihan run dan pemeriksaan Claude — 22 Oktober 2026

## Bukti paket dengan REA

REA 6.5.0 dari `/Users/asani/Downloads/rea-main`, skill
`.agents/skills/reverse-engineer-anything/SKILL.md`, dijalankan melalui CLI
`analyze-javascript-application` pada paket Anticode 0.0.70 yang terpasang.
Dipilih hanya `out/main/index.js` dan `out/preload/index.mjs`.

- Artifact SHA-256: `b9b1dc39096102da33be6dac6dbf04eb9983e7a77ad3982b220c69829343780b`.
- Evidence: `ev_a70832f2f1dd733a69b7e89b5dd02ba16078ebbdc2eba4df989f4456446ff518`.
- Dua source dianalisis, 94.544 AST nodes, 331 findings, tanpa parse failure.
- Terdapat 101 main handlers dan 101 renderer transmissions. Ekspresi kanal
  dinamis tetap unresolved menurut REA; pemetaan bukan bukti runtime.
- 10.214 file lainnya tidak dianalisis. Tidak ada klaim menyeluruh untuk SDK/dependency.

REA awalnya terhalang duplikasi modul SwiftBridging pada Command Line Tools.
Analisis berhasil dengan overlay filesystem khusus invocation compiler helper yang
menyembunyikan modulemap duplikat. Tidak ada file SDK sistem yang diubah, dan
pemeriksaan kepemilikan proses REA tetap dijalankan. Evidence lengkap lokal:
`/tmp/anticode-rea-focused-0.0.70.json`.

## Penyebab dan perubahan

1. Preflight subscription diulang setiap 30 detik per signal. Usage dan katalog
   mempunyai jalur baca yang dapat menambah request. Cache kini satu pemilik per
   hash token, single flight, batas freshness/lease, dan Retry-After. Informasi
   stale tidak diberi timestamp baru. Penolakan billing tetap fail closed.
2. Metadata 429 dan transport putus sebelumnya mempengaruhi cooldown inference.
   Error verifikasi kini bertag; hanya penolakan provider yang relevan menandai
   cooldown/kuota. Koneksi internet putus tidak menghabiskan akun.
3. Tool outputs dipangkas setelah tiga putaran meski konteks masih cukup. Bukti
   kini dipertahankan sampai tekanan budget; ringkasan menyimpan kepala dan ekor.
4. Satu fingerprint berulang menghentikan seluruh run meskipun tool lain memberi
   bukti baru. Sekarang penilaian dilakukan pada kemajuan putaran, dengan satu
   pemulihan, dan Continue boleh mengambil tindakan berbeda.
5. Registrasi satu lampiran mengembalikan semua berkas staged sebelumnya. Return
   kini hanya batch yang diminta. Draft menduplikasi berdasarkan identitas/path
   dan hash konten foto, termasuk kedatangan bersamaan; draft lain tetap terpisah.

## Verifikasi

Tes unit membedakan metadata 429 dari quota refusal, menguji cache lintas prompt,
revocation, token baru, pembatalan waiter, lease kedaluwarsa, recovery loop,
transport retry terbatas, serta isolasi dan deduplikasi lampiran.

`scripts/verify-run-resilience.mjs` memakai Electron, IPC, SDK, dan agent loop
produksi dengan provider fixture. Ini menguji puluhan putaran, bukti lama tetap
terkirim, partial stream terputus lalu pulih, koreksi pemeriksaan berulang sampai
menulis/membaca hasil, serta paste foto dan batch lampiran. Ini bukan benchmark
kemampuan model nyata dan tidak menjamin uptime layanan provider.

## Perbandingan OpenCode

REA juga menganalisis `out/main/index.js` dan `out/preload/index.js` dari
`/Applications/OpenCode.app/Contents/Resources/app.asar`.
Evidence `ev_97a5799a75e74b154af6f8efc2a8584fac61d9db6f74856b0ee4ab526d2934c2`,
SHA-256 artifact `13d76fbda5282b6e1cdb7a09f7622facfa754d0c61c449ce367bdf2e37f8a5ff`.
Dua source, 26.950 AST nodes, 267 findings, tanpa parse failure. Terdapat empat
kontradiksi hash pada file native unpacked. Analisis memakai
`--integrity-policy record-and-continue`; byte tersebut tetap berstatus tidak
terverifikasi, tidak dieksekusi untuk analisis, dan tidak dijadikan bukti perilaku backend.
Evidence lokal lengkap: `/tmp/anticode-rea-opencode.json`.

Sumber pembanding resmi yang sudah tersedia lokal berada pada commit
`133b1ebfafc3ae040b9b23ff3fcad49e273c9cf9`. Kecocokannya dengan binary desktop
terpasang tidak diklaim. Berkas `packages/core/src/model-retry.ts`,
`session/runner/retry.ts`, dan `session/compaction.ts` menunjukkan pemisahan
retry transport/provider, penjadwalan retry dalam sesi, dan pemadatan ketika
konteks menekan budget, bukan penghapusan bukti semata karena usia.

Anticode menerapkan prinsip yang cocok: retry transport singkat sampai lima
percobaan ulang dengan backoff per jeda maksimal 10 detik; timeout/HTTP tetap
punya budget lebih kecil; jeda bisa dibatalkan; retry berjalan dalam run yang
sama. Exhaustion fallback tidak lagi melempar terlalu awal sehingga retry
satu akun tetap dapat berjalan. Credential/billing dan SDK masing-masing
provider dipertahankan; tidak menyalin backend OpenCode atau mengasumsikan
semua endpoint identik.

## Pengujian provider nyata

Empat sesi coding memakai akun aktual melalui paket 0.0.71, pada folder sementara
terpisah dari proyek pengguna. Setiap sesi memperbaiki dua modul, menjalankan
sembilan acceptance tests yang diverifikasi ulang oleh host, dan menerima
instruksi tambahan saat run masih aktif untuk menulis laporan terverifikasi.
Berkas acceptance test tetap sama byte demi byte. Semua selesai dengan reason
`complete`; tidak menggunakan Continue manual.

| Model | Eksekusi tool | Durasi | Tes host + tambahan instruksi |
| --- | ---: | ---: | --- |
| Claude Sonnet 5.5 | 8 | 27 detik | Lulus |
| Muse Spark 1.3 Contributor / ClinePass | 17 | 66 detik | Lulus |
| GPT 6.1 Sol / Codex | 19 | 75 detik | Lulus |
| Claude Opus 5.5 | 8 | 29 detik | Lulus |

Pada sesi Muse, satu stream respons nyata sengaja diputus di boundary transport
hanya untuk sesi uji. Model kemudian melanjutkan dan menyelesaikan semua acceptance
criteria; hasil akhir diverifikasi melalui `node --test`, bukan sekadar HTTP 200.
Ini membuktikan skenario tersebut, bukan semua kemampuan atau semua jenis kegagalan.
Ringkasan mesin: [hasil live](run-resilience-live-2026-10-22.json).

Uji fixture aplikasi produksi menjalankan 83 tool calls dalam lebih dari 40
putaran, mempertahankan bukti awal, memulihkan partial stream serta pemeriksaan
berulang, lalu menulis dan membaca hasil. Pengujian lampiran meliputi pemulihan
foto duplikat lama setelah restart. Kondisi yang memang memblokir akses tetap
mempunyai penghentian terbatas; tidak ada klaim uptime provider tanpa batas.

## Soak session Claude nyata melewati cache expiry

Satu host tool menjalankan proses Node selama 310.085 ms (5 menit 10 detik),
dengan batas tool 400 detik. Setelah cache 5 menit habis, dua panggilan endpoint
pemeriksaan subscription sengaja dijawab 429 pada boundary fetch milik aplikasi
uji. Inference Claude tetap memakai provider nyata melalui mesin Claude Code.
Run menyelesaikan verifikasi output, menerima follow-up selama proses berjalan,
dan menulis penanda `STEERING_PRESERVED`. Outcome `complete`, dua tool calls,
tanpa Continue manual. Bukti authorization terakhir tidak diberi timestamp baru.

Ringkasan: [hasil soak nyata dengan fault metadata](run-resilience-claude-soak-2026-10-22.json).
Ini membuktikan kontinuitas host tool panjang dan grace period metadata pada
bukti yang masih berlaku. Bukti authorization kedaluwarsa, penolakan billing,
atau gangguan provider berkepanjangan tetap menghentikan run secara terbatas.
