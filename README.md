# EnergyTrack

Aplikasi pemantauan energi untuk mengelola fasilitas, meter, bacaan, biaya, alert, audit, emisi, forecast, dan laporan. Frontend menggunakan Vue 3 dan Vite; backend menggunakan Express, Prisma, dan PostgreSQL.

## Persiapan lokal

Persyaratan: Node.js 20 atau lebih baru, npm, PostgreSQL aktif pada port 5432, dan Git. Perintah berikut menggunakan PowerShell di Windows.

1. Clone repository dan instal dependensi:

   ```powershell
   git clone https://github.com/darrennicholas/EnergyTrack.git
   cd EnergyTrack
   npm install
   ```

2. Buat database PostgreSQL kosong bernama `energytrack` melalui HeidiSQL, pgAdmin, atau `CREATE DATABASE energytrack;`. User PostgreSQL harus dapat mengakses database dan membuat objek pada schema `public`.

3. Jalankan setup dari folder proyek:

   ```powershell
   npm run db:setup
   ```

   Masukkan username dan password PostgreSQL. Setup membuat `backend/.env`, menerapkan migrasi, dan mengisi akun awal. Jika file tersebut sudah ada dan tidak ditulis ulang, setup berhenti tanpa menjalankan migrasi atau seed. Untuk konfigurasi manual, salin `backend/.env.example` ke `backend/.env`, isi `DATABASE_URL` dan `SESSION_SECRET` acak minimal 32 karakter, lalu jalankan `npm run db:migrate` dan `npm run db:seed`.

4. Jalankan aplikasi:

   ```powershell
   npm run dev
   ```

   API berjalan di `http://127.0.0.1:3000`. Buka URL frontend yang ditampilkan Vite, biasanya `http://127.0.0.1:5173`; jika port dipakai, Vite dapat memilih port berikutnya seperti 5174. Bila mengatur `APP_ORIGINS` sendiri, sertakan origin frontend yang digunakan.

Akun awal lokal: `admin@energitrack.local`, password `developer123`. Seed juga membuat satu akun untuk setiap role bawaan. Password ini khusus pengembangan lokal; seed menolak berjalan dalam mode production. Data contoh tambahan bersifat ilustrasi dan dapat ditambahkan dengan `npm run db:seed:examples`. File `backend/.env` berisi kredensial lokal dan tidak boleh diunggah.

## Alur approval

| Proses | Pengaju / pelaksana | Persetujuan dan aturan |
| --- | --- | --- |
| Baseline | Admin atau Energy Manager mengelola baseline. | Admin atau Energy Manager menyetujui melalui permission `baseline.manage`; revisi tersimpan sebagai versi baru. |
| Audit energi | Auditor yang ditugaskan menjalankan dan mengirim audit; Admin atau Energy Manager dapat mengelolanya sesuai permission. | `audit.approve` diperlukan untuk menyetujui atau meminta revisi. Jika pemisahan tugas diaktifkan, pembuat audit tidak dapat menyetujui atau meminta revisi auditnya sendiri. Alasan revisi wajib diisi. |
| Penutupan audit | Pengguna dengan `audit.approve` menutup audit yang sudah disetujui. | Temuan harus memiliki tindakan dan seluruh tindakan harus ditutup; penutupan tindakan memerlukan hasil serta URL bukti. |

Akses aktual juga mengikuti permission role, organisasi, penugasan site, dan status data. Admin dapat mengatur role sesuai kebutuhan organisasi.

## Pemeriksaan

```powershell
npm test
npm run build
```

Untuk smoke test API, jalankan backend terlebih dahulu, lalu gunakan akun admin lokal:

```powershell
$env:ACCEPTANCE_EMAIL = 'admin@energitrack.local'
$env:ACCEPTANCE_PASSWORD = 'developer123'
npm run acceptance:smoke
```

Kontrak API tersedia di [docs/openapi.json](docs/openapi.json). Status kesesuaian FSD dan pekerjaan yang masih terbuka ada di [docs/fsd-v2-implementation-status.md](docs/fsd-v2-implementation-status.md). Pengoperasian worker, provider, backup, dan konfigurasi production dijelaskan di [docs/operations.md](docs/operations.md). GitHub Actions dan integrasi provider perlu diverifikasi pada environment yang dikonfigurasi.
