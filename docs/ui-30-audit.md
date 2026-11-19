# Audit UI terhadap 30 gambar referensi

Audit ini mencocokkan nama/route, cabang tampilan, dan pola visual di source dengan gambar `ui-reference/01_*.png` sampai `30_*.png`. Referensi menunjukkan produk berbahasa Inggris, tema hijau gelap, sidebar tetap, header pencarian, tabel/panel, dan grafik. Source memakai tema serta shell serupa, tetapi banyak labelnya berbahasa Indonesia.

Pemeriksaan runtime 19 November 2026: Dashboard pada `127.0.0.1:5174/dashboard` berhasil dimuat pada sesi admin dan dibandingkan dengan `ui-reference/01_dashboard.png`. Shell hijau gelap, sidebar, header, dan kelompok KPI/chart mengikuti arah referensi. Belum pixel-match: label/keterangan runtime berbahasa Indonesia sedangkan referensi berbahasa Inggris; nilai biaya belum tersedia, kelengkapan hanya 4.17%, panel distribusi site kosong, dan panel aktivitas memberi pesan permission. Screenshot runtime juga diambil pada viewport lebih kecil dari referensi 1440×900. Pemeriksaan ini hanya mencakup layar 01; 27 layar lain tetap perlu diperiksa.

| # | Gambar dan layar | Route | Implementasi saat ini | Hasil audit |
|---:|---|---|---|---|
| 01 | `01_dashboard.png` Dashboard | `/dashboard` | KPI konsumsi/biaya/kelengkapan/alert, grafik, ranking site | Struktur utama cocok; copy dan detail visual belum dicocokkan pada viewport. |
| 02 | `02_sites.png` Sites | `/sites` | Katalog berpaginasi, filter, sorting, status, buka detail | Struktur tabel cocok; teks dan kepadatan kolom berbeda. |
| 03 | `03_site-detail.png` Site Detail | `/sites/:id` | Shared detail hero, KPI, chart konsumsi dan aktivitas | Route benar; detail data/aksi masih memakai layout detail bersama. |
| 04 | `04_assets.png` Assets | `/assets` | Tabel aset melalui `recordPages`/`moduleColumns` | Ada data dan aksi dasar; tampilan masih tabel generik. |
| 05 | `05_asset-detail.png` Asset Detail | `/assets/:id` | Shared detail hero, KPI dan riwayat meter | Route benar; belum punya komposisi khusus seperti gambar. |
| 06 | `06_meters.png` Meters | `/meters` | Katalog meter dengan filter site/status, bacaan terakhir, sorting | Struktur utama tersedia; teks dan proporsi belum dicocokkan visual. |
| 07 | `07_meter-new.png` New Meter | `/meters/new` | Sebelumnya modal; sekarang ditampilkan sebagai halaman form dan judul New Meter | Perbaikan dilakukan; form/data aksi sudah ada, tetapi belum dibandingkan lewat screenshot browser. |
| 08 | `08_meter-detail.png` Meter Detail | `/meters/:id` | Shared detail + baca meter dan konfigurasi/maintenance | Fungsionalitas domain tersedia; visual masih berbagi template detail. |
| 09 | `09_monitoring-live.png` Monitoring Live | `/monitoring` | KPI dan grafik monitoring berbasis filter aktif | Kerangka utama cocok; komposisi/label perlu pemeriksaan runtime. |
| 10 | `10_monitoring-history.png` Monitoring History | `/monitoring/history` | Cabang monitoring yang sama dengan bucket/periode | Route tersedia; pemisahan visual live vs history masih tipis. |
| 11 | `11_imports.png` Data Imports | `/imports` | Upload, preview, status job, dan review kualitas | Alur khusus tersedia; layout perlu dicocokkan dengan gambar setelah browser hidup. |
| 12 | `12_import-detail.png` Import Detail | `/imports/:id` | Shared detail dengan status, accepted/rejected/duplicate, error rows | Data detail tersedia; masih memakai pola detail yang sama. |
| 13 | `13_tariffs.png` Tariffs | `/tariffs` | Tarif dan assignment; tabel/kolom domain tarif | Domain khusus tersedia; modal pembuatan belum setara komposisi gambar. |
| 14 | `14_cost-analysis.png` Cost Analysis | `/cost-analysis` | Kalkulasi biaya dan filter periode/site | Alur khusus tersedia; kesetaraan grafik/perbandingan belum dicek dari render. |
| 15 | `15_baselines.png` Baselines | `/baselines` | Daftar baseline dan alur approval/revisi | Data domain ada; halaman katalog masih memakai pola tabel bersama. |
| 16 | `16_targets.png` Energy Targets | `/targets` | Daftar dan progress target | Data domain ada; perbandingan progress visual belum dicocokkan satu per satu. |
| 17 | `17_alerts.png` Alerts | `/alerts` | Kartu alert dengan filter severity/status dan transisi | Tampilan/alur lebih khusus daripada CRUD umum; copy berbeda dari referensi. |
| 18 | `18_alert-rules.png` Alert Rules | `/alert-rules` | Form aturan dengan scope, metrik, threshold dan kanal | Field domain ada; daftar/form masih memakai panel katalog bersama. |
| 19 | `19_alert-detail.png` Alert Detail | `/alerts/:id` | Shared detail dengan severity/status/event timeline | Route dan transisi ada; belum punya detail visual khusus. |
| 20 | `20_audits.png` Energy Audits | `/audits` | Data audit, workflow, assignment, temuan dan corrective action | Alur domain tersedia; list masih berbagi tabel katalog. |
| 21 | `21_audit-detail.png` Audit Detail | `/audits/:id` | Detail workflow, evidence, findings dan corrective actions | Fungsionalitas khusus tersedia; hierarki visual belum sama persis. |
| 22 | `22_emissions.png` Emissions | `/emissions` | Katalog faktor dan estimator emisi | Domain tersedia; desain grafik/KPI belum diverifikasi lewat browser. |
| 23 | `23_reports.png` Reports | `/reports` | Builder, jobs, format, status dan unduhan | Alur khusus tersedia; form builder masih berbeda dari layout referensi. |
| 24 | `24_report-detail.png` Report Detail | `/reports/:id` | Shared detail dengan status, format, snapshot dan expiry | Data detail tersedia; menggunakan shared detail template. |
| 25 | `25_organization-settings.png` Organization Settings | `/settings/organization` | Form pengaturan organisasi | Form berfungsi; grouping dan label belum sama persis. |
| 26 | `26_users.png` User Management | `/settings/users` | Anggota, role/site assignment, undangan | Halaman khusus tersedia; teks berbahasa Indonesia dan kontrol tabel berbeda. |
| 27 | `27_roles.png` Roles & Permissions | `/settings/roles` | Daftar role dan grid permission | Fitur khusus tersedia; layout belum dicocokkan ke screenshot. |
| 28 | `28_integrations.png` Integrations | `/settings/integrations` | API keys, webhooks, delivery history | Halaman khusus tersedia; kartu dan pengaturan belum sama persis. |
| 29 | `29_audit-logs.png` Audit Logs | `/settings/audit-logs` | Tabel audit-log dari endpoint dengan pagination/sorting | Bukan lagi pesan statis; data real dipakai. Visual tabel belum diverifikasi browser. |
| 30 | `30_analytics.png` Analytics & Forecast | `/analytics` | Analitik, forecast, driver cuaca/produksi | Fitur khusus tersedia; chart/driver panel belum dicocokkan lewat screenshot. |

## Temuan lintas layar

- **Route dan fungsi menu:** 30 route referensi dipetakan di `frontend/src/router.ts`; sebagian detail sengaja menggunakan satu template dengan data dan aksi sesuai modul.
- **Bahasa:** gambar referensi memakai label Inggris, sementara source saat ini mencampur nama menu Inggris dengan label/form berbahasa Indonesia.
- **Template bersama:** Assets, Baselines, Targets, Alert Rules, Audits, Emissions, dan sebagian halaman katalog memakai pola tabel/form bersama. Ini berfungsi, tetapi belum menghasilkan komposisi yang sama dengan rancangan tiap layar.
- **Layar detail:** Site, asset, meter, import, alert, audit, dan report menggunakan pola detail bersama; panel KPI/riwayat tersedia, tetapi susunan spesifik gambar belum disamai.
- **Validasi visual:** file PNG referensi sudah diperiksa sebagai contact sheet. Screenshot aplikasi aktual untuk 30 route belum bisa diambil karena API/DB acceptance lokal pada port uji berhenti atau menolak koneksi. Jadi belum ada klaim pixel-match atau QA interaksi visual.

## Status

Perbaikan langsung yang dibuat dalam audit ini: route New Meter kini menyajikan form bergaya halaman penuh dan punya judul/keluar route yang sesuai. Frontend production build lulus. Sebelum menyebut 30 layar selesai, masih dibutuhkan screenshot aplikasi pada viewport referensi dan iterasi terhadap temuan visual per layar.
