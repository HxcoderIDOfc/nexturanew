# Nextura AI Router — Koyeb & Northflank

AI API Router OpenAI-compatible untuk dua provider:

- **Nextura/cortexa-pro** → Gonka
- **Nextura/cortexa-max** → CometAPI

## Fitur

- Endpoint OpenAI-compatible `/v1/chat/completions`
- Agent Search melalui Gonka
- Deep Thinking dapat diatur dari environment atau request
- Streaming SSE dengan heartbeat
- Auto-routing request bergambar ke Cortexa Max
- Filter reasoning tersembunyi
- API-key authentication dan rate limit
- Health check untuk Koyeb/Northflank
- Halaman dashboard uptime di `/`
- Endpoint ping publik di `/ping`
- Graceful shutdown saat Koyeb melakukan restart/deploy
- Siap build menggunakan Dockerfile

## Endpoint

```text
GET  /              halaman dashboard uptime
GET  /health        health check JSON
GET  /ping          ping publik JSON
GET  /v1/models     perlu API key
POST /v1/chat/completions
```

## Model publik

```text
Nextura/cortexa-pro
Nextura/cortexa-max
```

## Environment Variables

```env
NEXTURA_API_KEY=key-client-nextura
GONKA_API_KEY=key-gonka
COMET_API_KEY=key-cometapi

GONKA_BASE_URL=https://gate.joingonka.ai
GONKA_MODEL=MiniMaxAI/MiniMax-M2.7

COMET_BASE_URL=https://api.cometapi.com/v1
COMET_MODEL=gpt-5-nano-2025-08-07

ENABLE_AGENT_SEARCH=true
ENABLE_DEEP_THINKING=true
SEARCH_MAX_TOKENS=1800
MAX_OUTPUT_TOKENS=8192
SSE_HEARTBEAT_MS=15000
```

Koyeb menyediakan `PORT` secara otomatis. Server selalu bind ke `0.0.0.0`.
Jangan pernah menyimpan API key asli di GitHub.

# Deploy ke Koyeb

1. Masuk Koyeb dan pilih **Create Web Service**.
2. Pilih GitHub repository `HxcoderIDOfc/nexturanew`.
3. Branch: `main`.
4. Builder: **Dockerfile**.
5. Instance: **Free** bila tersedia.
6. Tambahkan semua environment variables di atas.
7. Exposed port/protocol: HTTP dan gunakan port dari aplikasi.
8. Health check path: `/health`.
9. Route publik: `/`.
10. Deploy.

Koyeb akan menggunakan command dari Dockerfile dan mengirim `SIGTERM` saat redeploy. Server sudah menangani graceful shutdown agar request aktif tidak langsung diputus secara kasar.

## Dashboard dan ping uptime

Setelah deploy, buka:

```text
https://NAMA-APP-KAMU.koyeb.app/
```

Halaman tersebut menampilkan:

- status online/offline;
- lama uptime container;
- platform;
- waktu ping terakhir;
- tombol ping manual.

Selama halaman dibuka, browser memanggil `/ping` setiap 30 detik.

Untuk monitoring eksternal gunakan:

```text
https://NAMA-APP-KAMU.koyeb.app/health
```

Atur UptimeRobot/Better Stack menggunakan HTTP GET. Interval 5 menit sudah cukup. Perlu diingat bahwa kebijakan free tier platform dapat berubah dan uptime monitor bukan jaminan resmi layanan 24/7.

# Deploy ke Northflank

1. Buat project baru.
2. Pilih **Create Service → Combined Service**.
3. Hubungkan repository `HxcoderIDOfc/nexturanew`.
4. Build menggunakan Dockerfile.
5. Tambahkan environment variables.
6. Public HTTP port: `8000` atau port yang ditentukan platform.
7. Health check: `/health`.
8. Deploy.

# Contoh request

```bash
curl https://DOMAIN-KAMU/v1/chat/completions \
  -H "Authorization: Bearer KEY-NEXTURA" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Nextura/cortexa-pro",
    "messages": [
      {"role": "user", "content": "Siapa kamu?"}
    ],
    "stream": false
  }'
```

## Agent Search

```json
{
  "agent_search": true,
  "review": true
}
```

Field `search: true` juga didukung.

Untuk Cortexa Pro, Gonka menjalankan pencarian langsung. Untuk Cortexa Max, Gonka mencari informasi lebih dahulu lalu konteks hasilnya diberikan ke CometAPI.

## Deep Thinking

Default server mengikuti:

```env
ENABLE_DEEP_THINKING=true
```

Bisa diubah per request:

```json
{
  "thinking": {
    "enabled": false,
    "show": false
  }
}
```

- `enabled: false` → respons lebih cepat.
- `enabled: true` → Gonka berpikir lebih dalam dan biasanya lebih lama.
- `show: false` → proses reasoning tidak ditampilkan.

## Streaming SSE

```bash
curl -N https://DOMAIN-KAMU/v1/chat/completions \
  -H "Authorization: Bearer KEY-NEXTURA" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Nextura/cortexa-pro",
    "messages": [
      {"role": "user", "content": "Jelaskan Cloudflare Workers"}
    ],
    "stream": true
  }'
```

Server mengirim heartbeat berkala:

```text
: nextura-heartbeat
```

## Jalankan lokal

```bash
npm install
cp .env.example .env
npm start
```

Node.js minimum: **22**.
