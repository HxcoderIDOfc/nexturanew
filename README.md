# Nextura AI Router — Northflank

AI API Router OpenAI-compatible untuk dua provider:

- **Nextura/cortexa-pro** → Gonka
- **Nextura/cortexa-max** → CometAPI

Fitur utama:

- Endpoint OpenAI-compatible `/v1/chat/completions`
- Agent Search melalui Gonka
- Gonka sebagai model utama teks/coding/search
- CometAPI sebagai model multimodal/fallback
- Otomatis mengarahkan request bergambar ke Cortexa Max
- Streaming SSE dengan heartbeat
- Filter reasoning tersembunyi
- Penyembunyian nama model upstream pada respons publik
- API key authentication
- Rate limit
- Health check
- Siap deploy menggunakan Docker di Northflank

## Endpoint

```text
GET  /
GET  /health
GET  /v1/models
POST /v1/chat/completions
```

## Model publik

```text
Nextura/cortexa-pro
Nextura/cortexa-max
```

## Environment Variables Northflank

Tambahkan variables berikut pada Northflank:

```env
NEXTURA_API_KEY=key-client-nextura
GONKA_API_KEY=key-gonka
COMET_API_KEY=key-cometapi

GONKA_BASE_URL=https://gate.joingonka.ai
GONKA_MODEL=MiniMaxAI/MiniMax-M2.7

COMET_BASE_URL=https://api.cometapi.com/v1
COMET_MODEL=gpt-5-nano-2025-08-07

ENABLE_AGENT_SEARCH=true
PORT=8000
HOST=0.0.0.0
```

Jangan memasukkan API key asli ke file `.env.example` atau repository.

## Deploy ke Northflank

1. Buat project baru di Northflank.
2. Pilih **Create Service → Combined Service**.
3. Hubungkan repository GitHub `HxcoderIDOfc/nexturanew`.
4. Pilih build menggunakan **Dockerfile**.
5. Tambahkan environment variables di atas.
6. Tambahkan public HTTP port `8000`.
7. Health check path: `/health`.
8. Deploy service.

Northflank otomatis memakai environment variable `PORT` bila platform menetapkan port sendiri.

## Contoh request biasa

```bash
curl https://DOMAIN-NORTHFLANK/v1/chat/completions \
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

Aktifkan agent search melalui salah satu field berikut:

```json
{
  "agent_search": true
}
```

atau:

```json
{
  "search": true
}
```

Contoh:

```bash
curl https://DOMAIN-NORTHFLANK/v1/chat/completions \
  -H "Authorization: Bearer KEY-NEXTURA" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Nextura/cortexa-pro",
    "messages": [
      {"role": "user", "content": "Cari berita teknologi terbaru hari ini"}
    ],
    "agent_search": true,
    "review": true,
    "stream": false
  }'
```

Untuk `Nextura/cortexa-pro`, pencarian diteruskan langsung ke Gonka. Untuk `Nextura/cortexa-max`, Gonka mencari informasi terlebih dahulu, lalu konteks hasil pencarian diberikan ke CometAPI untuk jawaban akhir.

## Streaming SSE

```bash
curl -N https://DOMAIN-NORTHFLANK/v1/chat/completions \
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

Server mengirim komentar heartbeat SSE secara berkala:

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
