# 📱 Nextura WhatsApp Bot

Nextura sekarang merupakan runtime **WhatsApp Bot ringan berbasis Baileys** dengan halaman QR login, session persistence, Plugin Manager berbasis web, auto-load plugin, monitoring health/uptime, dan integrasi AI melalui **nextura.my.id**.

> Sistem AI gateway, terminal agent, sandbox, Max Engine, Puppeteer, PDF tools, dan runtime lama sudah tidak digunakan.

## ✨ Fitur

- 📲 Login WhatsApp melalui QR di `/wa`
- 💾 Session WhatsApp dapat disimpan secara persistent
- 🧩 Auto-load plugin `.js` / `.mjs`
- 📝 Upload, buat, edit, dan hapus plugin langsung dari browser
- 🔐 Plugin Manager dilindungi `WA_ADMIN_KEY`
- 🤖 AI Chat menggunakan `https://nextura.my.id`
- 🔑 API key AI hanya dibaca dari environment
- ♻️ Auto reconnect WhatsApp
- ❤️ Health endpoint 1–3 tetap tersedia
- ⏱️ Uptime endpoint 1–3 tetap tersedia
- 🟢 Plugin contoh `ping`

## 🌐 Halaman & Endpoint

```text
GET  /                  halaman utama
GET  /wa                QR & status WhatsApp
GET  /wa/status         status koneksi WhatsApp
POST /wa/restart        restart koneksi WhatsApp
POST /wa/logout         logout session WhatsApp

GET  /plugins           Plugin Manager
GET  /api/plugins       daftar plugin (admin)
POST /api/plugins       buat/upload/edit plugin (admin)
GET  /api/plugins/:name baca plugin (admin)
DELETE /api/plugins/:name hapus plugin (admin)

GET /health
GET /health-1
GET /health-2
GET /health-3
GET /health/1
GET /health/2
GET /health/3

GET /uptime
GET /uptime-1
GET /uptime-2
GET /uptime-3
GET /uptime/1
GET /uptime/2
GET /uptime/3

GET /ping
```

## 🔐 Environment Variables

Jangan simpan API key asli di GitHub. Masukkan secret melalui Environment Variables hosting.

```env
PORT=8000
HOST=0.0.0.0

# Plugin Manager
WA_ADMIN_KEY=ganti-dengan-password-admin-yang-kuat
WA_PLUGIN_DIR=./wa-plugins
WA_PLUGIN_RELOAD_MS=5000

# Session WhatsApp
WA_SESSION_DIR=/data/nextura-wa-session

# Nextura AI
NEXTURA_AI_BASE_URL=https://nextura.my.id
NEXTURA_AI_API_KEY=masukkan-api-key-nextura
NEXTURA_AI_MODEL=Nextura/cortexa-nexus2.7
NEXTURA_AI_TIMEOUT_MS=120000
```

`NEXTURA_AI_API_KEY` adalah pilihan utama. Plugin AI juga dapat membaca `NEXTURA_API_KEY` sebagai fallback.

## 💾 Session WhatsApp Persistent

Baileys menyimpan kredensial WhatsApp di folder `WA_SESSION_DIR`.

Untuk hosting yang menyediakan persistent volume, mount volume misalnya ke:

```text
/data
```

kemudian gunakan:

```env
WA_SESSION_DIR=/data/nextura-wa-session
```

Dengan persistent storage, restart/redeploy aplikasi dapat menggunakan session yang sudah tersimpan sehingga QR tidak perlu dipindai setiap kali container restart.

> Jika hosting menghapus filesystem setiap redeploy dan tidak menggunakan persistent volume, session juga akan hilang dan QR perlu dipindai lagi.

## 📲 Menghubungkan WhatsApp

Setelah deploy buka:

```text
https://DOMAIN-KAMU/wa
```

1. Tunggu QR muncul.
2. Buka WhatsApp di HP.
3. Masuk ke **Perangkat tertaut / Linked devices**.
4. Scan QR dari halaman Nextura.
5. Setelah berhasil, status berubah menjadi `connected`.

Gunakan tombol **Logout sesi** hanya jika memang ingin melepas akun. Logout akan menghapus session sehingga QR baru diperlukan.

## 🧩 Plugin Manager

Buka:

```text
https://DOMAIN-KAMU/plugins
```

Masukkan nilai `WA_ADMIN_KEY`. Dari halaman tersebut kamu bisa:

- upload plugin baru;
- membuat plugin baru;
- membuka source plugin;
- mengedit source;
- menyimpan perubahan;
- menghapus plugin.

Plugin disimpan di folder `wa-plugins/` dan loader akan memeriksa perubahan secara otomatis.

### Struktur plugin sederhana

```js
export default async function plugin({ sock, message }) {
  const jid = message?.key?.remoteJid;
  if (!jid || message?.key?.fromMe) return;

  // logic plugin di sini
}
```

## 🤖 AI Chat Nextura

Plugin `wa-plugins/ai-chat.js` menggunakan endpoint:

```text
https://nextura.my.id/v1/chat/completions
```

API key diambil dari:

```env
NEXTURA_AI_API_KEY=...
```

Contoh penggunaan dari WhatsApp:

```text
.ai Halo, siapa kamu?
```

atau:

```text
ai Jelaskan Cloudflare Workers
```

Model dapat diganti tanpa mengubah source:

```env
NEXTURA_AI_MODEL=Nextura/cortexa-nexus2.7
```

## 🟢 Plugin Ping

Plugin bawaan `wa-plugins/ping.js` digunakan untuk mengetes apakah bot menerima pesan.

Kirim:

```text
ping
```

Bot akan memberikan balasan bahwa Nextura WA aktif.

## ❤️ Health & Uptime

Route monitoring lama tetap dipertahankan agar monitor yang sudah ada tidak perlu diubah:

```text
/health-1
/health-2
/health-3

/uptime-1
/uptime-2
/uptime-3
```

Selain itu tersedia `/health`, `/uptime`, `/ping`, serta alias `/health/1` sampai `/health/3` dan `/uptime/1` sampai `/uptime/3`.

Response health juga menampilkan status WhatsApp dan jumlah plugin aktif.

## 🚀 Menjalankan Lokal

Node.js minimum: **22**.

```bash
npm install
npm start
```

Untuk development:

```bash
npm run dev
```

## ☁️ Deploy

Project dapat dijalankan pada hosting Node.js yang mendukung Node 22+.

Konfigurasi dasar:

```text
Start command : npm start
Port          : 8000 / PORT dari hosting
Health check  : /health
```

Untuk session WhatsApp yang tahan restart/redeploy, gunakan hosting dengan persistent storage/volume dan arahkan `WA_SESSION_DIR` ke volume tersebut.

## 📁 Struktur Utama

```text
sdk-compat.js          Web server + halaman WA + Plugin Manager + health/uptime
whatsapp-bot.js        Koneksi Baileys, QR, session, reconnect, plugin loader
wa-plugins/
├── ping.js            Tes bot
└── ai-chat.js         Chat AI melalui nextura.my.id
```

## 🔒 Keamanan

- Jangan commit API key ke repository.
- Gunakan `WA_ADMIN_KEY` yang panjang dan acak.
- Jangan membagikan halaman Plugin Manager beserta admin key kepada orang lain.
- Jangan upload plugin yang tidak dipercaya karena plugin berjalan di proses Node.js bot.
- Simpan secret melalui dashboard environment hosting.

---

**Nextura WhatsApp Bot** — ringan, modular, dan plugin dapat dikelola langsung dari browser. 🚀
