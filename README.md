# Bot Telegram Jualan Otomatis

## Fitur
- Katalog produk otomatis
- Checkout lewat tombol Telegram
- Instruksi pembayaran
- Upload bukti transfer
- Konfirmasi admin
- Produk digital dikirim otomatis setelah admin konfirmasi
- Stok berkurang otomatis
- Riwayat pesanan pembeli
- Bisa dihosting di Vercel memakai webhook

## Cara pakai lokal
1. Install Node.js minimal versi 18.
2. Jalankan:
   ```bash
   npm install
   ```
3. Salin `.env.example` menjadi `.env`.
4. Isi `BOT_TOKEN` dari BotFather.
5. Isi `OWNER_ID` dengan ID Telegram owner dan `DEVELOPER_ID` dengan ID pengembang.
6. Edit `products.json` untuk mengubah produk, harga, dan stok.
7. Jalankan bot:
   ```bash
   npm start
   ```

## Deploy ke Vercel
1. Upload project ini ke GitHub.
2. Import repository ke Vercel.
3. Tambahkan Environment Variables di Vercel:
   - `BOT_TOKEN`
   - `OWNER_ID`
   - `DEVELOPER_ID`
   - `STORE_NAME`
   - `PAYMENT_INFO`
   - `OWNER_USERNAME`
4. Deploy project.
5. Setelah dapat domain Vercel, set webhook Telegram:
   ```bash
   curl "https://api.telegram.org/botTOKEN_BOT_ANDA/setWebhook?url=https://domain-anda.vercel.app/api/bot"
   ```
6. Tes endpoint:
   ```bash
   curl https://domain-anda.vercel.app/api/bot
   ```

## Format produk
```json
{
  "id": "akun-premium",
  "name": "Akun Premium 1 Bulan",
  "price": 25000,
  "description": "Akun siap pakai, garansi 3 hari.",
  "stock": ["email@example.com|password"]
}
```

## Panel admin
- Gunakan `/start`, lalu tekan tombol `🛠️ Admin Panel`.
- Semua fitur admin memakai tombol: tambah produk, kelola produk, ubah produk, tambah stok, habiskan stok, hapus produk, dan broadcast pembeli.

## Catatan Vercel
Vercel serverless tidak cocok untuk database file permanen. Bot ini bisa jalan untuk demo, tetapi stok dan pesanan di Vercel dapat reset. Untuk toko asli, gunakan database seperti Supabase, Neon, MongoDB Atlas, atau Vercel KV.

## Catatan
Bot ini memakai konfirmasi admin sebelum barang dikirim agar aman dari bukti transfer palsu. Untuk pembayaran otomatis penuh, perlu integrasi payment gateway.
