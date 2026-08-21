import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { getWhatsAppState, restartWhatsApp, logoutWhatsApp } from "./whatsapp-bot.js";
import { getConsoleLogs, clearConsoleLogs } from "./live-console.js";

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
  return String(req.headers["x-admin-key"] || url.searchParams.get("key") || "").trim() === ADMIN_KEY;
}
function requireAdmin(req, res, url) {
  if (!ADMIN_KEY) { send(res, 503, { error: "WA_ADMIN_KEY belum disetel di environment." }); return false; }
  if (!adminAuthorized(req, url)) { send(res, 401, { error: "Admin key tidak valid." }); return false; }
  return true;
}
function safePluginName(value) {
  const name = path.basename(String(value || "").trim());
  if (!/^[a-zA-Z0-9._-]+\.(?:js|mjs)$/.test(name)) throw new Error("Nama plugin harus .js/.mjs.");
  return name;
}
function pluginPath(name) {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  const safe = safePluginName(name);
  return { safe, target: path.join(PLUGIN_DIR, safe) };
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
  return { ok: true, service: "Axynera WhatsApp Bot", health: index, whatsapp: wa.status, connected: wa.status === "connected", auto_read: wa.autoRead, plugins: wa.pluginCount || 0, uptime_seconds: Math.floor((Date.now() - startedAt) / 1000), timestamp: new Date().toISOString() };
}
function uptimePayload(index = null) {
  const wa = getWhatsAppState();
  return { ok: true, service: "Axynera WhatsApp Bot", uptime: index, uptime_seconds: Math.floor((Date.now() - startedAt) / 1000), started_at: new Date(startedAt).toISOString(), whatsapp: wa.status, connected: wa.status === "connected", timestamp: new Date().toISOString() };
}

function nav() {
  return `<nav><a href="/wa">WhatsApp</a><a href="/plugins">Plugins</a><a href="/console">Live Console</a></nav>`;
}
function css() {
  return `*{box-sizing:border-box}body{margin:0;background:#07110c;color:#edfff4;font:14px system-ui;padding:18px}a{color:#6cf0a0;text-decoration:none}nav{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px}.wrap{max-width:1100px;margin:auto}.panel{background:#0d1d14;border:1px solid #244b36;border-radius:16px;padding:16px}.top{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}input,textarea,button{font:inherit}input,textarea{background:#08150e;color:#effff5;border:1px solid #244b36;border-radius:10px;padding:10px}button,.btn{border:0;border-radius:10px;padding:10px 13px;font-weight:700;cursor:pointer;background:#25d366;color:#05210f}.danger{background:#5a2028;color:#ffe1e5}.muted{color:#94b3a1}`;
}
function whatsappPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Axynera WA</title><style>${css()}.qr{min-height:340px;display:grid;place-items:center;background:#fff;border-radius:18px;padding:12px}.qr img{max-width:100%}.empty{color:#173226}</style></head><body><div class="wrap">${nav()}<div class="panel"><h1>WhatsApp Axynera</h1><p class="muted">Auto-read aktif dan session dipakai kembali selama storage persistent tersedia.</p><div id="status">Memuat...</div><div class="qr" id="qr"><div class="empty">Menunggu QR...</div></div><div class="top"><button onclick="act('/wa/restart')">Muat ulang QR</button><button class="danger" onclick="logoutWA()">Logout sesi</button></div><div id="meta" class="muted"></div></div></div><script>async function act(u){await fetch(u,{method:'POST'});refresh()}async function logoutWA(){if(confirm('Logout session?'))await act('/wa/logout')}async function refresh(){try{const s=await(await fetch('/wa/status',{cache:'no-store'})).json();status.textContent='Status: '+s.status;qr.innerHTML=s.qrDataUrl?'<img src="'+s.qrDataUrl+'">':'<div class="empty">'+(s.status==='connected'?'WhatsApp sudah terhubung ✅':'QR belum tersedia...')+'</div>';meta.innerHTML='Nomor: '+(s.phone||'-')+' · Plugin: '+(s.pluginCount||0)+' · Auto-read: '+(s.autoRead?'ON':'OFF')+'<br>Session: '+(s.sessionDir||'-')}catch(e){status.textContent=e.message}}refresh();setInterval(refresh,2000)</script></body></html>`;
}
function pluginManagerPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Plugin Manager</title><style>${css()}.grid{display:grid;grid-template-columns:260px 1fr;gap:14px}.list button{display:block;width:100%;text-align:left;margin:6px 0;background:#14291d;color:#fff}textarea{width:100%;min-height:450px;font-family:monospace}@media(max-width:760px){.grid{grid-template-columns:1fr}}</style></head><body><div class="wrap">${nav()}<h1>Plugin Manager</h1><div class="top"><input id="key" type="password" placeholder="WA_ADMIN_KEY"><button onclick="saveKey()">Simpan key</button><input id="upload" type="file" accept=".js,.mjs"><button onclick="uploadFile()">Upload</button></div><div id="msg"></div><div class="grid"><div class="panel"><div id="list" class="list"></div><button onclick="newPlugin()">+ Plugin baru</button></div><div class="panel"><div class="top"><input id="name" placeholder="plugin.js"><button onclick="savePlugin()">Simpan</button><button class="danger" onclick="deletePlugin()">Hapus</button></div><textarea id="code"></textarea></div></div></div><script>const K='axynera_wa_admin_key';key.value=localStorage.getItem(K)||'';function saveKey(){localStorage.setItem(K,key.value);loadList()}function h(){return {'x-admin-key':key.value,'content-type':'application/json'}}async function api(u,o={}){const r=await fetch(u,{...o,headers:{...h(),...(o.headers||{})}});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request gagal');return d}async function loadList(){try{const d=await api('/api/plugins');list.innerHTML=d.plugins.map(p=>'<button onclick="openPlugin(\''+p.name+'\')">'+p.name+'</button>').join('')}catch(e){msg.textContent=e.message}}async function openPlugin(n){const d=await api('/api/plugins/'+encodeURIComponent(n));name.value=d.name;code.value=d.content}function newPlugin(){name.value='plugin-baru.js';code.value='export default async function plugin({ sock, message, log }) {\n  // logic plugin\n}\n'}async function savePlugin(){await api('/api/plugins',{method:'POST',body:JSON.stringify({name:name.value,content:code.value})});loadList()}async function deletePlugin(){if(confirm('Hapus '+name.value+'?')){await api('/api/plugins/'+encodeURIComponent(name.value),{method:'DELETE'});name.value='';code.value='';loadList()}}async function uploadFile(){const f=upload.files[0];if(!f)return;await api('/api/plugins',{method:'POST',body:JSON.stringify({name:f.name,content:await f.text()})});loadList()}loadList()</script></body></html>`;
}
function consolePage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Axynera Live Console</title><style>${css()}.console{background:#020805;border:1px solid #1d3b2a;border-radius:14px;min-height:520px;max-height:72vh;overflow:auto;padding:12px;font-family:ui-monospace,monospace}.row{padding:9px 0;border-bottom:1px solid #13261b;white-space:pre-wrap;word-break:break-word}.t{color:#789787}.in{color:#8bd5ff}.out{color:#a7f3d0}.ai{color:#f9d58b}.err{color:#ff9b9b}</style></head><body><div class="wrap">${nav()}<h1>Live Console</h1><p class="muted">Pesan masuk, balasan bot, request AI, response AI, dan error. Dilindungi WA_ADMIN_KEY.</p><div class="top"><input id="key" type="password" placeholder="WA_ADMIN_KEY"><button onclick="saveKey()">Hubungkan</button><button class="danger" onclick="clearLogs()">Bersihkan</button><span id="st" class="muted"></span></div><div id="console" class="console"></div></div><script>const K='axynera_wa_admin_key';key.value=localStorage.getItem(K)||'';let last=0;function saveKey(){localStorage.setItem(K,key.value);last=0;console.innerHTML='';poll()}function esc(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}function cls(t){return t==='wa_in'?'in':t==='wa_out'?'out':t.startsWith('ai_')?'ai':t.includes('error')?'err':''}async function poll(){if(!key.value)return st.textContent='Masukkan admin key';try{const r=await fetch('/api/console?after='+last,{headers:{'x-admin-key':key.value},cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Gagal');for(const x of d.logs||[]){last=Math.max(last,x.id);const div=document.createElement('div');div.className='row '+cls(x.type);div.innerHTML='<span class="t">['+new Date(x.time).toLocaleTimeString()+']</span> '+esc(x.type)+' '+esc(x.contact||x.jid||x.model||'')+'\n'+esc(x.text||x.error||x.status||'');console.appendChild(div)}if((d.logs||[]).length)console.scrollTop=console.scrollHeight;st.textContent='LIVE · '+new Date().toLocaleTimeString()}catch(e){st.textContent=e.message}}async function clearLogs(){await fetch('/api/console',{method:'DELETE',headers:{'x-admin-key':key.value}});last=0;console.innerHTML=''}poll();setInterval(poll,1000)</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost"); const p = url.pathname;
  try {
    if (req.method === "GET" && p === "/") return sendHtml(res, `<!doctype html><html><head><meta charset="utf-8"><style>${css()}</style></head><body><div class="wrap">${nav()}<div class="panel"><h1>Axynera WhatsApp Bot</h1><p>Bot WA ringan + Plugin Manager + Live Console.</p></div></div></body></html>`);
    if (req.method === "GET" && p === "/wa") return sendHtml(res, whatsappPage());
    if (req.method === "GET" && p === "/plugins") return sendHtml(res, pluginManagerPage());
    if (req.method === "GET" && p === "/console") return sendHtml(res, consolePage());
    if (req.method === "GET" && p === "/wa/status") return send(res, 200, getWhatsAppState());
    if (req.method === "POST" && p === "/wa/restart") return send(res, 200, await restartWhatsApp());
    if (req.method === "POST" && p === "/wa/logout") return send(res, 200, await logoutWhatsApp());

    if (p === "/api/console") {
      if (!requireAdmin(req, res, url)) return;
      if (req.method === "GET") return send(res, 200, { logs: getConsoleLogs(url.searchParams.get("after")) });
      if (req.method === "DELETE") { clearConsoleLogs(); return send(res, 200, { ok: true }); }
    }
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

    const healthMatch = p.match(/^\/health(?:[-\/]?([123]))?$/); if (req.method === "GET" && healthMatch) return send(res, 200, healthPayload(healthMatch[1] ? Number(healthMatch[1]) : null));
    const uptimeMatch = p.match(/^\/uptime(?:[-\/]?([123]))?$/); if (req.method === "GET" && uptimeMatch) return send(res, 200, uptimePayload(uptimeMatch[1] ? Number(uptimeMatch[1]) : null));
    if (req.method === "GET" && p === "/ping") return send(res, 200, healthPayload());
    return send(res, 404, { error: "Endpoint tidak ditemukan." });
  } catch (error) { return send(res, 400, { error: error.message || String(error) }); }
});
server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 75000); server.headersTimeout = server.keepAliveTimeout + 5000;
function shutdown(signal) { console.log(`[axynera-wa] Shutdown ${signal}`); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); }
process.once("SIGTERM", () => shutdown("SIGTERM")); process.once("SIGINT", () => shutdown("SIGINT"));
server.listen(PORT, HOST, () => console.log(`[axynera-wa] online http://${HOST}:${PORT} · /wa · /plugins · /console`));