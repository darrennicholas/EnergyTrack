# Status historis implementasi FSD v1

> Catatan: dokumen ini mencatat audit FSD v1 dan tidak lagi menjadi status terbaru. Untuk rencana revisi EnergiTrack FSD v2.0, gunakan [fsd-v2-implementation-status.md](fsd-v2-implementation-status.md); status v2 mencerminkan perubahan dan pemeriksaan pada revisi ini.

Status ini memisahkan source code, pemeriksaan otomatis yang benar-benar dijalankan, dan pekerjaan yang memerlukan environment/provider eksternal. Angka operasional atau keberhasilan produksi tidak dinyatakan tanpa bukti run.

## Perubahan dan status

| Area | Status source code | Bukti / batas verifikasi |
|---|---|---|
| Reaggregation bacaan | Rollup harian persisten per meter dan timezone lokal; cumulative delta/reset/rollover; queue PostgreSQL dengan retry; pembaruan rentang terdampak; backfill pada migrasi. Monitoring memakai rollup bila cakupan lengkap dan tugas selesai, selain itu menghitung dari bacaan mentah. | Migrasi deployment lokal pengguna telah diterapkan dan Prisma melaporkan schema up to date. Belum mengukur beban setara produksi. |
| Rekonsiliasi monitoring | Cache per proses dilepas; hasil dihitung dari database. Acceptance smoke menguji kombinasi filter dan bucket, serta membandingkan data dengan ekspor. | Suite acceptance domain ada di workflow CI, tetapi belum dijalankan terhadap database lokal pengguna atau GitHub-hosted runner. |
| Permission, tenant, tarif, archive | Guard berdasarkan permission dan site assignment; suite RBAC/domain mencakup role bawaan/custom, tenant isolation, revocation, tarif historis, SoD audit, dan archive site. | Bukan matriks kombinasi seluruh operasi/role. Acceptance tetap perlu dijalankan di environment CI/staging yang terisolasi. |
| Worker terpisah | API production dapat berjalan tanpa poller; `backend npm run start:worker` memproses queue impor, meter health, alert, rollup, report, email outbox, dan webhook. | Source tersedia; belum menjalankan beberapa replica worker atau uji restart/backlog pada staging. |
| Email dan scanning bukti | Provider dipilih: Resend untuk email dan Cloudmersive untuk scanning. Adapter Cloudmersive mengirim multipart dan menolak hasil tidak bersih; gateway generik tetap didukung. | Tes unit scanner memakai respons simulasi. Akun, domain dan kredensial belum dikonfigurasi; pengiriman, retry dan scanning nyata belum diuji. Lihat `docs/operations.md`. |
| Object storage dan retensi | Amazon S3 dipilih untuk report/evidence dan backup; filesystem hanya untuk development. Report memiliki expiry configurable dan worker menghapus artifact kedaluwarsa dengan audit event. | Belum diuji dengan bucket/credential organisasi; encryption, lifecycle, access log dan retention policy perlu diverifikasi terhadap provider. |
| Pagination | Endpoint daftar yang dipetakan OpenAPI memiliki page/pageSize/sort/direction/search dan response envelope; bacaan menggunakan cursor. | Pemeriksaan kontrak menemukan 30 response daftar berpaginasi. Detail, statistik dan endpoint non-list tidak dipaksa menjadi pagination. Penerimaan nilai/filter perlu dijalankan melalui CI. |
| OpenAPI | Schema success khusus per operasi, schema error, query/body/response, serta envelope pagination dihasilkan dari daftar operasi Express. | Pemeriksaan statis lolos: 99 paths, 126 operasi, 56 schema body, 30 envelope pagination, nol placeholder response/request. Pemeriksaan statis tidak menggantikan pengujian runtime tiap operasi. |
| Forecast eksogen | `EXOGENOUS_LINEAR` membaca driver cuaca dan produksi yang tersimpan. API menyediakan CRUD paginasi untuk data driver; UI menyediakan input data harian dan sinkronisasi prakiraan cuaca Open-Meteo berbasis koordinat/timezone site. | Forecast cuaca menggunakan endpoint publik Open-Meteo; belum diverifikasi live dari server ini. Data produksi dapat dimasukkan manual/API; konektor ERP/produksi khusus belum tersedia karena belum ada pemasok atau kredensial yang ditentukan. Perlu acceptance historis pada data site. |
| Backup, restore, SLO | Workflow GitHub menyediakan backup off-site, checksum dan restore drill terisolasi; workflow CI menjalankan beban dashboard API dengan gate P95. Restore drill memerlukan checksum dan menolak database tujuan yang tidak kosong. | Backup dan restore drill lokal lulus pada database acceptance terisolasi; GitHub, penyimpanan off-site dan hosting produksi belum diuji. Ketersediaan 99.5% dan SLO hosting belum dibuktikan. |
| Deployment | Konfigurasi Docker/Compose/Nginx dihapus sesuai arahan; alur CI memakai GitHub Actions. | Target hosting dan secrets deployment belum disediakan; belum mengklaim deployment produksi. |
| UI 30 layar | Router memetakan seluruh 30 screen di Lampiran A. Route New Meter kini menampilkan form seperti halaman penuh; layar detail dan katalog domain menggunakan data endpoint. | Audit source dan 30 PNG dicatat di `docs/ui-30-audit.md`. Tema/shell searah dengan referensi, tetapi label bahasa berbeda dan beberapa katalog/detail masih memakai template bersama. Belum ada capture aplikasi di viewport 1440×900; pixel-match belum dibuktikan. |

## Pemeriksaan yang dijalankan

- `npm run contract:openapi` — lulus: 99 paths, 126 operasi, 30 respons daftar berpaginasi.
- `npm test` — lulus: 16 file test, 51 unit tests.
- `npm run build` — lulus: backend TypeScript dan frontend production build.
- `npm run build -w frontend` — lulus setelah penyesuaian tampilan route New Meter.
- Acceptance RBAC pada database sementara port 55432 — lulus termasuk custom role `meter.configure`, pembatasan aset/site/tenant, dan penolakan pembuatan aset tanpa izin.
- Acceptance RBAC tambahan — enam role bawaan diuji terhadap POST `/roles`, `/invitations`, `/integration-sources`, `/webhooks`, dan `/sites`; seluruhnya ditolak dengan HTTP 403. Ini belum mencakup seluruh operasi.
- Load lokal pada database sementara — 40 request, concurrency 10, 0 gagal, P95 248,7 ms. Ini bukan pengukuran beban pada hosting produksi.
- Backup dan restore drill lokal — checksum valid, 43 migrasi selesai dan 8 site terbaca; pengulangan pada database yang sudah berisi data ditolak.
- `npx tsc -p backend/tsconfig.json --noEmit` — lulus pada source backend saat ini. `npm run build -w backend` dicoba ulang tetapi Prisma generate gagal mengganti `query_engine-windows.dll.node` (`EPERM`); ini masalah file lock/akses pada environment, bukan error TypeScript yang terlihat.
- Migrasi lokal memakai `prisma migrate deploy` (tanpa reset data); status terakhir: database up to date, 43 migrasi ditemukan.

Belum dilakukan: acceptance end-to-end pada basis data aplikasi yang sudah berisi data, eksekusi workflow pada GitHub, uji provider eksternal, backup off-site dan restore dari provider nyata, uji load pada hosting target, atau penerimaan visual runtime untuk semua 30 gambar. Load test sebelumnya menghasilkan HTTP 403 karena request tidak membawa site assignment; script memilih site yang tampak oleh akun uji; pengukuran ulang lokal lulus setelah akun fixture digunakan dengan scope organisasi. Build backend lengkap juga perlu diulang ketika Prisma Engine dapat diganti oleh environment.
