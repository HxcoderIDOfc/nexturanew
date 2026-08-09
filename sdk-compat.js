import http from "node:http";
import { getWhatsAppState, restartWhatsApp, logoutWhatsApp } from "./whatsapp-bot.js";

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";
const startedAt = Date.now();

function send(res, status, data) {
  const raw = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(raw),
    "cache-control": "no-store"
  });
  res.end(raw);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(html);
}

function healthPayload(index = null) {
  const wa = getWhatsAppState();
  return {
    ok: true,
    service: "Nextura WhatsApp Bot",
    health: index,
    whatsapp: wa.status,
    connected: wa.status === "connected",
    plugins: wa.pluginCount || 0,
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString()
  };
}

function uptimePayload(index = null) {
  const wa = getWhatsAppState();
  return {
    ok: true,
    service: "Nextura WhatsApp Bot",
    uptime: index,
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    started_at: new Date(startedAt).toISOString(),
    whatsapp: wa.status,
    connected: wa.status === "connected",
    timestamp: new Date().toISOString()
  };
}

function whatsappPage() {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nextura WhatsApp</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,sans-serif;background:radial-gradient(circle at top,#123d2d 0,#08110e 45%,#050706 100%);color:#eefaf4;min-height:100vh;display:grid;place-items:center;padding:20px}.card{width:min(520px,100%);background:rgba(12,24,19,.78);border:1px solid rgba(120,255,179,.18);backdrop-filter:blur(18px);border-radius:24px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,.35)}h1{margin:0 0 6px;font-size:26px}.muted{color:#a9c6b8;font-size:14px}.status{display:inline-flex;gap:8px;align-items:center;margin:18px 0;padding:8px 12px;border-radius:999px;background:#11271d}.dot{width:9px;height:9px;border-radius:50%;background:#f0b429}.qr{min-height:340px;display:grid;place-items:center;background:white;border-radius:18px;padding:12px;margin:8px 0 18px}.qr img{max-width:100%;display:block}.empty{color:#173226;text-align:center}.row{display:flex;gap:10px;flex-wrap:wrap}.btn{border:0;border-radius:12px;padding:11px 15px;font-weight:700;cursor:pointer}.primary{background:#25d366;color:#07180e}.danger{background:#4b1d24;color:#ffdce1}.meta{margin-top:16px;font-size:13px;color:#9ab5a8;line-height:1.7}</style></head><body><main class="card"><h1>WhatsApp Bot Nextura</h1><div class="muted">Scan QR untuk menghubungkan akun WhatsApp. Status diperbarui otomatis.</div><div class="status"><span class="dot" id="dot"></span><span id="status">Memuat...</span></div><div class="qr" id="qr"><div class="empty">Menunggu QR...</div></div><div class="row"><button class="btn primary" onclick="restartWA()">Muat ulang QR</button><button class="btn danger" onclick="logoutWA()">Logout sesi</button></div><div class="meta" id="meta"></div></main><script>
async function action(url){await fetch(url,{method:'POST'});await refresh()}async function restartWA(){await action('/wa/restart')}async function logoutWA(){if(confirm('Logout sesi WhatsApp dan buat QR baru?'))await action('/wa/logout')}
async function refresh(){try{const r=await fetch('/wa/status',{cache:'no-store'});const s=await r.json();status.textContent=s.status||'unknown';dot.style.background=s.status==='connected'?'#25d366':s.status==='qr'?'#f0b429':'#ff6b6b';qr.innerHTML=s.qrDataUrl?'<img alt="WhatsApp QR" src="'+s.qrDataUrl+'">':'<div class="empty">'+(s.status==='connected'?'WhatsApp sudah terhubung ✅':'QR belum tersedia, tunggu sebentar...')+'</div>';meta.innerHTML='Nomor: '+(s.phone||'-')+'<br>Plugin aktif: '+(s.pluginCount??0)+'<br>Update: '+new Date(s.updatedAt||Date.now()).toLocaleString()+(s.lastError?'<br>Error: '+s.lastError:'')}catch(e){status.textContent='error';meta.textContent=e.message}}refresh();setInterval(refresh,2000)
</script></body></html>`;
}

function homePage() {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nextura WA Bot</title><style>body{margin:0;background:#07110c;color:#edfff4;font-family:system-ui;display:grid;place-items:center;min-height:100vh}.c{padding:28px;border:1px solid #244b36;border-radius:22px;background:#0d1d14;text-align:center}a{color:#43e889}</style></head><body><div class="c"><h1>Nextura WhatsApp Bot</h1><p>Runtime ringan khusus WhatsApp.</p><a href="/wa">Buka QR WhatsApp →</a></div></body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const p = url.pathname;

  if (req.method === "GET" && p === "/") return sendHtml(res, homePage());
  if (req.method === "GET" && p === "/wa") return sendHtml(res, whatsappPage());
  if (req.method === "GET" && p === "/wa/status") return send(res, 200, getWhatsAppState());
  if (req.method === "POST" && p === "/wa/restart") return void restartWhatsApp().then(s => send(res, 200, s)).catch(e => send(res, 500, { error: e.message }));
  if (req.method === "POST" && p === "/wa/logout") return void logoutWhatsApp().then(s => send(res, 200, s)).catch(e => send(res, 500, { error: e.message }));

  const healthMatch = p.match(/^\/health(?:\/?([123]))?$/);
  if (req.method === "GET" && healthMatch) return send(res, 200, healthPayload(healthMatch[1] ? Number(healthMatch[1]) : null));
  const uptimeMatch = p.match(/^\/uptime(?:\/?([123]))?$/);
  if (req.method === "GET" && uptimeMatch) return send(res, 200, uptimePayload(uptimeMatch[1] ? Number(uptimeMatch[1]) : null));
  if (req.method === "GET" && p === "/ping") return send(res, 200, healthPayload());

  return send(res, 404, { error: "Endpoint tidak ditemukan." });
});

server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 75000);
server.headersTimeout = server.keepAliveTimeout + 5000;

function shutdown(signal) {
  console.log(`[nextura-wa] Shutdown ${signal}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
server.listen(PORT, HOST, () => console.log(`[nextura-wa] online http://${HOST}:${PORT} · QR /wa`));
