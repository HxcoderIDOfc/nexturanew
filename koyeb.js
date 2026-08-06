import http from "node:http";
import { spawn } from "node:child_process";

const PUBLIC_PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT || (PUBLIC_PORT === 8000 ? 8001 : 8000));
const startedAt = Date.now();

const child = spawn(process.execPath, ["server.js"], {
  env: {
    ...process.env,
    PORT: String(INTERNAL_PORT),
    HOST: "127.0.0.1"
  },
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  console.error(`[koyeb] Nextura router berhenti. code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

function uptimeSeconds() {
  return Math.floor((Date.now() - startedAt) / 1000);
}

function uptimePayload(channel) {
  return {
    ok: true,
    service: "Nextura AI Router",
    channel,
    platform: process.env.KOYEB_APP_NAME ? "Koyeb" : "Node.js",
    uptime_seconds: uptimeSeconds(),
    timestamp: new Date().toISOString()
  };
}

function uptimeHtml(channel, intervalSeconds) {
  const safeChannel = String(channel).replace(/[^a-zA-Z0-9_-]/g, "");
  const safeInterval = Math.max(15, Number(intervalSeconds) || 60);

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Nextura Uptime ${safeChannel}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#07101d;color:#eef5ff;font-family:Inter,system-ui,Arial,sans-serif}.card{width:min(640px,100%);padding:28px;border:1px solid #263a58;border-radius:24px;background:linear-gradient(145deg,#101e34,#0b1728);box-shadow:0 24px 70px #0008}.head{display:flex;align-items:center;gap:14px}.dot{width:16px;height:16px;border-radius:50%;background:#f59e0b;box-shadow:0 0 18px #f59e0b}.dot.ok{background:#22c55e;box-shadow:0 0 18px #22c55e}.dot.err{background:#ef4444;box-shadow:0 0 18px #ef4444}h1{margin:0;font-size:27px}.muted{color:#95a8c5}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:24px}.box{padding:16px;border:1px solid #203451;border-radius:16px;background:#091425}.label{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#8196b7}.value{margin-top:7px;font-size:17px;word-break:break-word}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}button,a{border:0;border-radius:12px;padding:11px 15px;font-weight:700;text-decoration:none;cursor:pointer}button{background:#4f8cff;color:white}a{background:#182944;color:#dceaff}.foot{margin-top:18px;font-size:13px;color:#7589aa}@media(max-width:560px){.grid{grid-template-columns:1fr}.card{padding:21px}}
  </style>
</head>
<body>
  <main class="card">
    <div class="head"><span id="dot" class="dot"></span><div><h1>Nextura Uptime ${safeChannel}</h1><div id="status" class="muted">Memeriksa server…</div></div></div>
    <section class="grid">
      <div class="box"><div class="label">Status</div><div id="state" class="value">CHECKING</div></div>
      <div class="box"><div class="label">Channel</div><div class="value">${safeChannel}</div></div>
      <div class="box"><div class="label">Uptime</div><div id="uptime" class="value">-</div></div>
      <div class="box"><div class="label">Ping terakhir</div><div id="last" class="value">-</div></div>
    </section>
    <div class="actions"><button onclick="check()">Ping sekarang</button><a href="/health-${safeChannel}" target="_blank">JSON Health</a><a href="/" target="_blank">Dashboard utama</a></div>
    <div class="foot">Halaman ini melakukan ping setiap ${safeInterval} detik. Untuk layanan uptime eksternal, gunakan URL <b>/health-${safeChannel}</b>.</div>
  </main>
<script>
  const fmt=s=>{s=Math.max(0,Number(s)||0);const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60),x=Math.floor(s%60);return [d&&d+' hari',h&&h+' jam',m&&m+' menit',x+' detik'].filter(Boolean).join(' ')};
  async function check(){const dot=document.getElementById('dot');try{const r=await fetch('/health-${safeChannel}?ts='+Date.now(),{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);const d=await r.json();dot.className='dot ok';document.getElementById('status').textContent='Server online dan merespons';document.getElementById('state').textContent='ONLINE';document.getElementById('uptime').textContent=fmt(d.uptime_seconds);document.getElementById('last').textContent=new Date().toLocaleString('id-ID')}catch(e){dot.className='dot err';document.getElementById('status').textContent='Server tidak merespons';document.getElementById('state').textContent='OFFLINE';document.getElementById('last').textContent=new Date().toLocaleString('id-ID')}}
  check();setInterval(check,${safeInterval * 1000});
</script>
</body>
</html>`;
}

const PAGE_CONFIG = {
  "/uptime-1": { channel: "1", interval: 60 },
  "/uptime-2": { channel: "2", interval: 120 },
  "/uptime-3": { channel: "3", interval: 180 }
};

const HEALTH_CONFIG = {
  "/health-1": "1",
  "/health-2": "2",
  "/health-3": "3"
};

function proxyRequest(req, res) {
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: INTERNAL_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${INTERNAL_PORT}`
    }
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({
      error: {
        message: "Nextura router belum siap atau tidak dapat dihubungi.",
        detail: error.message
      }
    }));
  });

  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  if (req.method === "GET" && PAGE_CONFIG[pathname]) {
    const config = PAGE_CONFIG[pathname];
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    return res.end(uptimeHtml(config.channel, config.interval));
  }

  if ((req.method === "GET" || req.method === "HEAD") && HEALTH_CONFIG[pathname]) {
    const body = JSON.stringify(uptimePayload(HEALTH_CONFIG[pathname]));
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body)
    });
    return req.method === "HEAD" ? res.end() : res.end(body);
  }

  proxyRequest(req, res);
});

server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 75_000);
server.headersTimeout = server.keepAliveTimeout + 5_000;

function shutdown(signal) {
  console.log(`[koyeb] Shutdown ${signal}`);
  server.close(() => {
    if (!child.killed) child.kill("SIGTERM");
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

server.listen(PUBLIC_PORT, HOST, () => {
  console.log(`[koyeb] Gateway online di http://${HOST}:${PUBLIC_PORT}`);
  console.log(`[koyeb] Router internal di http://127.0.0.1:${INTERNAL_PORT}`);
});
