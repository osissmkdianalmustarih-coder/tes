# Sistem Absensi OSIS (Vercel + Supabase)

## Langkah Deployment Cepat (Tinggal Pindah)

1. **Setup Database Supabase**
   - Buka proyek di [Supabase](https://supabase.com) -> **SQL Editor**.
   - Salin dan jalankan seluruh isi file `schema.sql`.
   - Buka **Project Settings -> API**, lalu salin `Project URL` dan `service_role` secret key.

2. **Upload ke GitHub & Deploy ke Vercel**
   - Upload seluruh isi folder ini ke repositori GitHub kamu.
   - Buka [Vercel](https://vercel.com) -> **Add New -> Project** -> Import repositori tersebut.
   - Masuk ke **Settings -> Environment Variables** di Vercel, lalu tambahkan:
     - `SUPABASE_URL` = URL proyek Supabase kamu
     - `SUPABASE_SERVICE_ROLE_KEY` = Service Role Key Supabase kamu
     - `FONNTE_TOKEN` = Token API Fonnte (untuk notifikasi & broadcast WhatsApp)
   - Klik **Deploy / Redeploy**.

3. **Login Awal**
   - **Kode Petugas OSIS default:** `1234`
   - **Admin Developer default:** Username `developer`, Password `123456` (segera ubah setelah login).
