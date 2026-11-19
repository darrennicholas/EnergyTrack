# Konfigurasi produksi EnergyTrack

Pilihan provider: **Resend** untuk email transaksi, **Amazon S3** untuk report, bukti, dan backup, serta **Cloudmersive Virus Scan** untuk pemeriksaan bukti. Aktivasi membutuhkan akun yang dikelola pemilik proyek, domain email yang telah diverifikasi, dan kredensial yang disimpan sebagai secret di lingkungan hosting. Jangan commit file `.env` atau mengirim secret melalui chat.

## Konfigurasi aplikasi

Isi environment backend dan worker dengan `NODE_ENV=production`, `DATABASE_URL`, `SESSION_SECRET` dan `WEBHOOK_ENCRYPTION_KEY` yang masing-masing acak dan minimal 32 karakter, `APP_PUBLIC_URL` berbasis HTTPS dan `APP_ORIGINS` yang sesuai dengan origin frontend. Jalankan migrasi yang disetujui sebelum memulai API dan worker.

- Resend: isi `EMAIL_DELIVERY_URL=https://api.resend.com/emails`, `EMAIL_DELIVERY_TOKEN` dengan API key, dan `EMAIL_FROM_ADDRESS` dengan alamat pada domain yang telah diverifikasi. [Resend Send Email API](https://resend.com/docs/api-reference/emails/send-email).
- Amazon S3: buat bucket privat, aktifkan block public access dan enkripsi default, lalu isi `OBJECT_STORAGE_ENDPOINT` (contoh `https://s3.ap-southeast-1.amazonaws.com`), `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_ACCESS_KEY`, dan `OBJECT_STORAGE_SECRET_KEY`. Berikan akses minimum yang diperlukan untuk objek bucket. [Dokumentasi enkripsi S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/specifying-s3-encryption.html).
- Cloudmersive: isi `EVIDENCE_SCAN_PROVIDER=cloudmersive`, `EVIDENCE_SCAN_URL=https://api.cloudmersive.com/virus/scan/file` dan `EVIDENCE_SCAN_TOKEN` dengan API key. Berkas bukti dikirim ke Cloudmersive untuk pemindaian; pastikan penggunaan ini sesuai kebijakan data organisasi. [Dokumentasi Cloudmersive](https://api.cloudmersive.com/docs/virus.asp).

Konfigurasi ini belum membuat akun, bucket, domain, atau secret, dan belum membuktikan layanan eksternal berfungsi. Setelah konfigurasi tersedia, verifikasi pengiriman dan retry email, hasil scan bersih dan sampel uji antivirus aman, serta upload/download/delete dan retensi objek pada bucket uji.

## Backup dan restore

Workflow GitHub memerlukan `BACKUP_DATABASE_URL`, `BACKUP_AWS_ACCESS_KEY_ID`, `BACKUP_AWS_SECRET_ACCESS_KEY`, `BACKUP_AWS_REGION`, `BACKUP_S3_BUCKET` dan `DRILL_DATABASE_URL` sebagai secrets. Untuk Amazon S3 standar, kosongkan `BACKUP_S3_ENDPOINT_URL`. Database drill harus terisolasi dan kosong. Workflow backup diunggah terenkripsi dengan SSE-S3; tetapkan lifecycle bucket sesuai kebijakan retensi dan lakukan restore drill berkala. Pastikan versi `pg_dump` pada runner minimal sama dengan versi server PostgreSQL sumber.

## Bukti lokal terakhir

Acceptance RBAC, load lokal dan restore drill lokal dijelaskan di [fsd-status.md](fsd-status.md). GitHub Actions, backup off-site dan provider sungguhan perlu diuji setelah repository, akun dan secrets tersedia.
