import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { getWhatsAppState, restartWhatsApp, logoutWhatsApp } from "./whatsapp-bot.js";

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";
const startedAt = Date.now();
const PLUGIN_DIR = path.resolve(process.env.WA_PLUGIN_DIR || "./wa-plugins");
const ADMIN_KEY = String(process.env.WA_ADMIN_KEY || "").trim();
const BODY_LIMIT = Number(process.env.BODY_LIMIT_BYTES || 2 * 1024 * 1024);

function send(res, status, data) {
  const raw = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(raw), "cache-control": "no-store" });
  res.end(raw);
}
function sendHtml(res, html) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(html); }
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > BODY_LIMIT) throw new Error("Payload terlalu besar"); chunks.push(chunk); }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
function adminAuthorized(req, url) {
  if (!ADMIN_KEY) return false;
  const key = String(req.headers["x-admin-key"] || url.searchParams.get("key") || "").trim();
  return key === ADMIN_KEY;
}
function requireAdmin(req, res, url) {
  if (!ADMIN_KEY) { send(res, 503, { error: "WA_ADMIN_KEY belum disetel di environment." }); return false; }
  if (!adminAuthorized(req, url)) { send(res, 401, { error: "Admin key tidak valid." }); return false; }
  return true;
}
function safePluginName(value) {
  const name = path.basename(String(value || "").trim());
  if (!/^[a-zA-Z0-9._-]+\.(?:js|mjs)$/.test(name)) throw new Error("Nama plugin harus .js/.mjs dan hanya berisi huruf, angka, titik, strip, underscore.");
  return name;
}
function pluginPath(name) {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  const safe = safePluginName(name);
  const target = path.resolve(PLUGIN_DIR, safe);
  if (path.dirname(target) !== PLUGIN_DIR) throw new Error("Path plugin tidak valid.");
  return { safe, target };
}
function listPlugins() {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  return fs.readdirSync(PLUGIN_DIR).filter(x => /\.(js|mjs)$/.test(x)).sort().map(name => {
    const stat = fs.statSync(path.join(PLUGIN_DIR, name));
    return { name, size: stat.size, updatedAt: stat.mtimeMs };
  });
}

function healthPayload(index = null) {
  const wa = getWhatsAppState();
  return { ok: true, service: "Nextura WhatsApp Bot", health: index, whatsapp: wa.status, connected: wa.status === "connected", plugins: wa.pluginCount || 0, uptime_seconds: Math.floor((Date.now() - startedAt) / 1000), timestamp: new Date().toISOString() };
}
function uptimePayload(index = null) {
  const wa = getWhatsAppState();
  return { ok: true, service: "Nextura WhatsApp Bot", uptime: index, uptime_seconds: Math.floor((Date.now() - startedAt) / 1000), started_at: new Date(startedAt).toISOString(), whatsapp: wa.status, connected: wa.status === "connected", timestamp: new Date().toISOString() };
}

function whatsappPage() {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nextura WhatsApp</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font-family:system-ui;background:radial-gradient(circle at top,#123d2d,#08110e 45%,#050706);color:#eefaf4;min-height:100vh;display:grid;place-items:center;padding:20px}.card{width:min(540px,100%);background:#0c1813dd;border:1px solid #78ffb32e;border-radius:24px;padding:24px}.muted{color:#a9c6b8}.status{display:inline-flex;gap:8px;align-items:center;margin:18px 0;padding:8px 12px;border-radius:999px;background:#11271d}.dot{width:9px;height:9px;border-radius:50%;background:#f0b429}.qr{min-height:340px;display:grid;place-items:center;background:white;border-radius:18px;padding:12px;margin:8px 0 18px}.qr img{max-width:100%}.empty{color:#173226;text-align:center}.row{display:flex;gap:10px;flex-wrap:wrap}.btn,a.btn{border:0;border-radius:12px;padding:11px 15px;font-weight:700;cursor:pointer;text-decoration:none}.primary{background:#25d366;color:#07180e}.secondary{background:#20342b;color:#eefaf4}.danger{background:#4b1d24;color:#ffdce1}.meta{margin-top:16px;font-size:13px;color:#9ab5a8;line-height:1.7}</style></head><body><main class="card"><h1>WhatsApp Bot Nextura</h1><div class="muted">Scan sekali, lalu session dipakai kembali selama folder session tetap tersimpan.</div><div class="status"><span class="dot" id="dot"></span><span id="status">Memuat...</span></div><div class="qr" id="qr"><div class="empty">Menunggu QR...</div></div><div class="row"><button class="btn primary" onclick="act('/wa/restart')">Muat ulang QR</button><button class="btn danger" onclick="logoutWA()">Logout sesi</button><a class="btn secondary" href="/plugins">Plugin Manager</a></div><div class="meta" id="meta"></div></main><script>async function act(u){await fetch(u,{method:'POST'});refresh()}async function logoutWA(){if(confirm('Logout session WhatsApp? QR baru akan diperlukan.'))await act('/wa/logout')}async function refresh(){try{const s=await(await fetch('/wa/status',{cache:'no-store'})).json();status.textContent=s.status||'unknown';dot.style.background=s.status==='connected'?'#25d366':s.status==='qr'?'#f0b429':'#ff6b6b';qr.innerHTML=s.qrDataUrl?'<img src="'+s.qrDataUrl+'">':'<div class="empty">'+(s.status==='connected'?'WhatsApp sudah terhubung ✅':'QR belum tersedia...')+'</div>';meta.innerHTML='Nomor: '+(s.phone||'-')+'<br>Plugin aktif: '+(s.pluginCount??0)+'<br>Session: '+(s.sessionDir||'-')+(s.lastError?'<br>Error: '+s.lastError:'')}catch(e){status.textContent='error';meta.textContent=e.message}}refresh();setInterval(refresh,2000)</script></body></html>`;
}

function pluginManagerPage() {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nextura Plugin Manager</title><style>*{box-sizing:border-box}body{margin:0;background:#07110c;color:#edfff4;font:14px system-ui;padding:18px}.wrap{max-width:1050px;margin:auto}.top{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}input,textarea,button{font:inherit}input,textarea{background:#0d1d14;color:#effff5;border:1px solid #244b36;border-radius:10px;padding:10px}input{min-width:220px}textarea{width:100%;min-height:440px;font-family:ui-monospace,monospace;line-height:1.5}.grid{display:grid;grid-template-columns:260px 1fr;gap:14px}.panel{background:#0d1d14;border:1px solid #244b36;border-radius:16px;padding:14px}.list button{display:block;width:100%;text-align:left;margin:6px 0;background:#14291d;color:#eafff1;border:0;padding:10px;border-radius:9px}.btn{border:0;border-radius:10px;padding:10px 13px;font-weight:700;cursor:pointer;background:#25d366;color:#05210f}.danger{background:#5a2028;color:#ffe1e5}.muted{color:#94b3a1}.msg{min-height:20px;margin:8px 0;color:#85f0ac}@media(max-width:760px){.grid{grid-template-columns:1fr}textarea{min-height:360px}}</style></head><body><div class="wrap"><h1>Plugin Manager</h1><p class="muted">Upload, buat, edit, dan hapus plugin tanpa masuk terminal. Masukkan WA_ADMIN_KEY sekali; disimpan di browser ini.</p><div class="top"><input id="key" type="password" placeholder="WA_ADMIN_KEY"><button class="btn" onclick="saveKey()">Simpan key</button><input id="upload" type="file" accept=".js,.mjs"><button class="btn" onclick="uploadFile()">Upload plugin</button><a href="/wa" style="color:#7df2a6">QR WhatsApp</a></div><div id="msg" class="msg"></div><div class="grid"><div class="panel"><h3>Plugins</h3><div id="list" class="list"></div><button class="btn" onclick="newPlugin()">+ Plugin baru</button></div><div class="panel"><div class="top"><input id="name" placeholder="nama-plugin.js"><button class="btn" onclick="savePlugin()">Simpan</button><button class="btn danger" onclick="deletePlugin()">Hapus</button></div><textarea id="code" spellcheck="false"></textarea></div></div></div><script>const K='nextura_wa_admin_key';key.value=localStorage.getItem(K)||'';function saveKey(){localStorage.setItem(K,key.value);note('Key disimpan di browser.');loadList()}function h(){return {'x-admin-key':key.value,'content-type':'application/json'}}function note(t){msg.textContent=t;setTimeout(()=>{if(msg.textContent===t)msg.textContent=''},3500)}async function api(u,o={}){const r=await fetch(u,{...o,headers:{...h(),...(o.headers||{})}});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request gagal');return d}async function loadList(){try{const d=await api('/api/plugins');list.innerHTML=d.plugins.map(p=>'<button onclick="openPlugin('+JSON.stringify(p.name).replace(/"/g,'&quot;')+')">'+p.name+'</button>').join('')||'<span class="muted">Belum ada plugin</span>'}catch(e){note(e.message)}}async function openPlugin(n){try{const d=await api('/api/plugins/'+encodeURIComponent(n));name.value=d.name;code.value=d.content}catch(e){note(e.message)}}function newPlugin(){name.value='plugin-baru.js';code.value='export default async function plugin({ sock, message }) {\n  const jid = message?.key?.remoteJid;\n  if (!jid || message?.key?.fromMe) return;\n  // tulis logic plugin di sini\n}\n'}async function savePlugin(){try{await api('/api/plugins',{method:'POST',body:JSON.stringify({name:name.value,content:code.value})});note('Plugin tersimpan ✅');loadList()}catch(e){note(e.message)}}async function deletePlugin(){if(!name.value||!confirm('Hapus '+name.value+'?'))return;try{await api('/api/plugins/'+encodeURIComponent(name.value),{method:'DELETE'});note('Plugin dihapus');name.value='';code.value='';loadList()}catch(e){note(e.message)}}async function uploadFile(){const f=upload.files[0];if(!f)return note('Pilih file dulu');try{await api('/api/plugins',{method:'POST',body:JSON.stringify({name:f.name,content:await f.text()})});note('Upload berhasil ✅');loadList();openPlugin(f.name)}catch(e){note(e.message)}}loadList()</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost"); const p = url.pathname;
  try {
    if (req.method === "GET" && p === "/") return sendHtml(res, `<!doctype html><html><body style="background:#07110c;color:#edfff4;font-family:system-ui;display:grid;place-items:center;min-height:100vh"><div><h1>Nextura WhatsApp Bot</h1><p><a style="color:#53e98e" href="/wa">QR WhatsApp</a> · <a style="color:#53e98e" href="/plugins">Plugin Manager</a></p></div></body></html>`);
    if (req.method === "GET" && p === "/wa") return sendHtml(res, whatsappPage());
    if (req.method === "GET" && p === "/plugins") return sendHtml(res, pluginManagerPage());
    if (req.method === "GET" && p === "/wa/status") return send(res, 200, getWhatsAppState());
    if (req.method === "POST" && p === "/wa/restart") return send(res, 200, await restartWhatsApp());
    if (req.method === "POST" && p === "/wa/logout") return send(res, 200, await logoutWhatsApp());

    if (p === "/api/plugins") {
      if (!requireAdmin(req, res, url)) return;
      if (req.method === "GET") return send(res, 200, { plugins: listPlugins() });
      if (req.method === "POST") { const body = await readJson(req); const { safe, target } = pluginPath(body.name); fs.writeFileSync(target, String(body.content ?? ""), "utf8"); return send(res, 200, { ok: true, name: safe }); }
    }
    if (p.startsWith("/api/plugins/")) {
      if (!requireAdmin(req, res, url)) return;
      const name = decodeURIComponent(p.slice("/api/plugins/".length)); const { safe, target } = pluginPath(name);
      if (req.method === "GET") { if (!fs.existsSync(target)) return send(res, 404, { error: "Plugin tidak ditemukan." }); return send(res, 200, { name: safe, content: fs.readFileSync(target, "utf8") }); }
      if (req.method === "DELETE") { if (fs.existsSync(target)) fs.unlinkSync(target); return send(res, 200, { ok: true, name: safe }); }
    }

    const healthMatch = p.match(/^\/health(?:\/?([123]))?$/); if (req.method === "GET" && healthMatch) return send(res, 200, healthPayload(healthMatch[1] ? Number(healthMatch[1]) : null));
    const uptimeMatch = p.match(/^\/uptime(?:\/?([123]))?$/); if (req.method === "GET" && uptimeMatch) return send(res, 200, uptimePayload(uptimeMatch[1] ? Number(uptimeMatch[1]) : null));
    if (req.method === "GET" && p === "/ping") return send(res, 200, healthPayload());
    return send(res, 404, { error: "Endpoint tidak ditemukan." });
  } catch (error) { return send(res, 400, { error: error.message || String(error) }); }
});

server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 75000); server.headersTimeout = server.keepAliveTimeout + 5000;
function shutdown(signal) { console.log(`[nextura-wa] Shutdown ${signal}`); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); }
process.once("SIGTERM", () => shutdown("SIGTERM")); process.once("SIGINT", () => shutdown("SIGINT"));
server.listen(PORT, HOST, () => console.log(`[nextura-wa] online http://${HOST}:${PORT} · QR /wa · plugins /plugins`));
