# 📱 Nextura WhatsApp Bot

Runtime WhatsApp Bot ringan berbasis **Baileys** dengan QR login, session persistent, auto-read, Plugin Manager, Live Console, auto-load plugin, health/uptime, dan integrasi AI melalui **Nextura API**.

> Runtime AI gateway, terminal agent, sandbox, Puppeteer, PDF tools, dan engine lama sudah tidak dipakai.

## ✨ Fitur

- 📲 QR WhatsApp di `/wa`
- 💾 Session persistent lewat `WA_SESSION_DIR`
- 👁️ Auto-read pesan masuk
- 🧩 Auto-load plugin `.js` / `.mjs`
- 📝 Upload, buat, edit, dan hapus plugin dari browser
- 🖥️ Live Console untuk pesan masuk, balasan bot, request AI, response AI, dan error
- 🔐 `/plugins` dan `/console` dilindungi `WA_ADMIN_KEY`
- 🤖 AI Chat melalui `https://api.nextura.my.id`
- 🔎 Model AI dapat dideteksi otomatis lewat `/v1/models`
- ♻️ Auto reconnect WhatsApp
- ❤️ Health 1–3 tetap tersedia
- ⏱️ Uptime 1–3 tetap tersedia

## 🌐 Halaman & Endpoint

```text
GET  /                  halaman utama
GET  /wa                QR + status WhatsApp
GET  /wa/status         status koneksi
POST /wa/restart        restart koneksi
POST /wa/logout         logout session

GET  /plugins           Plugin Manager
GET  /console           Live Console

GET    /api/plugins
POST   /api/plugins
GET    /api/plugins/:name
DELETE /api/plugins/:name

GET    /api/console
DELETE /api/console

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

Jangan simpan API key asli di GitHub.

```env
PORT=8000
HOST=0.0.0.0

# Admin panel
WA_ADMIN_KEY=ganti-dengan-password-admin-yang-kuat

# WhatsApp
WA_AUTO_READ=true
WA_SESSION_DIR=/data/nextura-wa-session
WA_PLUGIN_RELOAD_MS=5000
WA_CONSOLE_MAX_LOGS=500

# Opsional
# WA_PLUGIN_DIR=/data/wa-plugins

# Nextura AI
NEXTURA_AI_BASE_URL=https://api.nextura.my.id
NEXTURA_AI_API_KEY=masukkan-api-key-nextura

# Opsional. Kosong = auto baca /v1/models
NEXTURA_AI_MODEL=
NEXTURA_AI_TIMEOUT_MS=120000
```

## 🤖 AI Chat Nextura

Plugin `wa-plugins/ai-chat.js` memakai:

```text
POST https://api.nextura.my.id/v1/chat/completions
```

Jika `NEXTURA_AI_MODEL` kosong, plugin terlebih dahulu membaca:

```text
GET https://api.nextura.my.id/v1/models
```

lalu memilih model yang tersedia. Ini menghindari hardcode model yang bisa berubah.

Contoh penggunaan WhatsApp:

```text
.ai Halo, siapa kamu?
```

atau:

```text
ai Jelaskan Cloudflare Workers
```

## 👁️ Auto-read

Default:

```env
WA_AUTO_READ=true
```

Setiap pesan masuk akan ditandai sudah dibaca sebelum plugin memprosesnya. Untuk mematikan:

```env
WA_AUTO_READ=false
```

## 🖥️ Live Console

Buka:

```text
https://DOMAIN-KAMU/console
```

Masukkan `WA_ADMIN_KEY`. Console refresh otomatis setiap sekitar 1 detik dan menampilkan:

- pesan WhatsApp masuk;
- pesan keluar dari bot;
- prompt yang dikirim ke Nextura AI;
- model AI yang dipakai;
- jawaban AI;
- status koneksi;
- plugin error / API error.

Log console disimpan sementara di memory dan dibatasi oleh `WA_CONSOLE_MAX_LOGS`.

## 🧩 Plugin Manager

Buka:

```text
https://DOMAIN-KAMU/plugins
```

Masukkan `WA_ADMIN_KEY`. Kamu bisa upload, buat, edit, simpan, dan hapus plugin langsung dari browser.

Contoh plugin:

```js
export default async function plugin({ sock, message, log }) {
  const jid = message?.key?.remoteJid;
  if (!jid || message?.key?.fromMe) return;

  log?.("plugin_info", { jid, text: "Plugin jalan" });
}
```

## 💾 Session WhatsApp Persistent

Gunakan persistent volume yang di-mount ke `/data`, lalu:

```env
WA_SESSION_DIR=/data/nextura-wa-session
```

Selama folder tersebut tidak hilang, bot dapat memakai session lama setelah restart/redeploy tanpa scan QR lagi.

## ❤️ Health & Uptime

Route monitoring lama tetap ada:

```text
/health-1
/health-2
/health-3
/uptime-1
/uptime-2
/uptime-3
```

Selain itu ada `/health`, `/uptime`, `/ping`, serta alias `/health/1..3` dan `/uptime/1..3`.

## 🚀 Menjalankan

Node.js minimum **22**.

```bash
npm install
npm start
```

Untuk cek syntax:

```bash
npm run check
```

## ☁️ Docker / Deploy

Dockerfile sekarang dibuat ringan dan tidak lagi meng-install Chromium/Puppeteer/font stack lama.

```text
Start command : npm start
Health check  : /health
Port          : PORT dari hosting, default 8000
```

`WORKDIR /app` pada Docker adalah normal. Jika log npm menulis `npm error path /app`, baris itu hanya menunjukkan direktori kerja; lihat baris error tepat di atas/bawahnya untuk penyebab spesifik. Dockerfile saat ini sudah disederhanakan agar instalasi dependency lebih ringan.

## 📁 Struktur

```text
start.js               bootstrap session path
sdk-compat.js          web server, QR, Plugin Manager, Live Console, health/uptime
whatsapp-bot.js        Baileys, auto-read, session, reconnect, plugin loader
live-console.js        ring buffer log Live Console
wa-plugins/
├── ping.js
└── ai-chat.js
```

## 🔒 Keamanan

- Jangan commit API key.
- Gunakan `WA_ADMIN_KEY` panjang dan acak.
- Jangan bagikan akses `/plugins` atau `/console` beserta admin key.
- Isi Live Console dapat memuat percakapan WhatsApp, jadi perlakukan sebagai data privat.
- Jangan upload plugin yang tidak dipercaya karena plugin berjalan di proses Node.js bot.

---

**Nextura WhatsApp Bot** — ringan, modular, dan bisa dikelola dari browser. 🚀
