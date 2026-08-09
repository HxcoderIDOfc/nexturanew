import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { getWhatsAppState, restartWhatsApp, logoutWhatsApp } from "./whatsapp-bot.js";

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";
const CORE_PORT = Number(process.env.SDK_CORE_PORT || (PORT === 8000 ? 8020 : PORT + 20));
const LIMIT = Number(process.env.BODY_LIMIT_BYTES || 10 * 1024 * 1024);
const MODEL = process.env.NEXTURA_MAX_MODEL_ID || "Nextura/cortexa-max";

const child = spawn(process.execPath, ["terminal-agent.js"], {
  env: { ...process.env, PORT: String(CORE_PORT), HOST: "127.0.0.1" }, stdio: "inherit"
});
child.on("exit", (code, signal) => { console.error(`[sdk-compat] core berhenti code=${code} signal=${signal}`); process.exit(code ?? 1); });

function send(res, status, data) {
  const raw = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(raw), "cache-control": "no-store" });
  res.end(raw);
}
function sendHtml(res, html) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > LIMIT) throw new Error("Payload terlalu besar"); chunks.push(c); }
  return Buffer.concat(chunks).toString("utf8");
}
function headersOf(headers = {}) {
  const h = { ...headers, host: `127.0.0.1:${CORE_PORT}` };
  const key = String(headers["x-api-key"] || headers["x-nextura-key"] || "").trim();
  if (!h.authorization && key) h.authorization = `Bearer ${key}`;
  return h;
}
function core(path, headers, raw) {
  return new Promise((resolve, reject) => {
    const h = headersOf(headers); h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(raw); delete h["transfer-encoding"];
    const r = http.request({ hostname: "127.0.0.1", port: CORE_PORT, path, method: "POST", headers: h }, (resp) => {
      const chunks = []; resp.on("data", c => chunks.push(c)); resp.on("end", () => resolve({ status: resp.statusCode || 502, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject); r.end(raw);
  });
}
function proxy(req, res, raw) {
  const h = headersOf(req.headers);
  if (raw !== undefined) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(raw); delete h["transfer-encoding"]; }
  const r = http.request({ hostname: "127.0.0.1", port: CORE_PORT, path: req.url, method: req.method, headers: h }, u => { res.writeHead(u.statusCode || 502, u.headers); u.pipe(res); });
  r.on("error", e => send(res, 502, { error: { message: "Nextura core belum siap.", code: "core_unavailable", detail: e.message } }));
  if (raw !== undefined) r.end(raw); else req.pipe(r);
}

function whatsappPage() {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nextura WhatsApp</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,sans-serif;background:radial-gradient(circle at top,#123d2d 0,#08110e 45%,#050706 100%);color:#eefaf4;min-height:100vh;display:grid;place-items:center;padding:20px}.card{width:min(520px,100%);background:rgba(12,24,19,.78);border:1px solid rgba(120,255,179,.18);backdrop-filter:blur(18px);border-radius:24px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,.35)}h1{margin:0 0 6px;font-size:26px}.muted{color:#a9c6b8;font-size:14px}.status{display:inline-flex;gap:8px;align-items:center;margin:18px 0;padding:8px 12px;border-radius:999px;background:#11271d}.dot{width:9px;height:9px;border-radius:50%;background:#f0b429}.qr{min-height:340px;display:grid;place-items:center;background:white;border-radius:18px;padding:12px;margin:8px 0 18px}.qr img{max-width:100%;display:block}.empty{color:#173226;text-align:center}.row{display:flex;gap:10px;flex-wrap:wrap}.btn{border:0;border-radius:12px;padding:11px 15px;font-weight:700;cursor:pointer}.primary{background:#25d366;color:#07180e}.secondary{background:#20342b;color:#eefaf4}.danger{background:#4b1d24;color:#ffdce1}.meta{margin-top:16px;font-size:13px;color:#9ab5a8;line-height:1.7}</style></head><body><main class="card"><h1>WhatsApp Bot Nextura</h1><div class="muted">Scan QR untuk menghubungkan akun WhatsApp. Halaman ini auto-refresh status tanpa reload.</div><div class="status"><span class="dot" id="dot"></span><span id="status">Memuat...</span></div><div class="qr" id="qr"><div class="empty">Menunggu QR...</div></div><div class="row"><button class="btn primary" onclick="restartWA()">Muat ulang QR</button><button class="btn danger" onclick="logoutWA()">Logout sesi</button></div><div class="meta" id="meta"></div></main><script>
async function action(url){await fetch(url,{method:'POST'});await refresh()}async function restartWA(){await action('/wa/restart')}async function logoutWA(){if(confirm('Logout sesi WhatsApp dan buat QR baru?'))await action('/wa/logout')}
async function refresh(){try{const r=await fetch('/wa/status',{cache:'no-store'});const s=await r.json();status.textContent=s.status||'unknown';dot.style.background=s.status==='connected'?'#25d366':s.status==='qr'?'#f0b429':'#ff6b6b';qr.innerHTML=s.qrDataUrl?'<img alt="WhatsApp QR" src="'+s.qrDataUrl+'">':'<div class="empty">'+(s.status==='connected'?'WhatsApp sudah terhubung ✅':'QR belum tersedia, tunggu sebentar...')+'</div>';meta.innerHTML='Nomor: '+(s.phone||'-')+'<br>Plugin aktif: '+(s.pluginCount??0)+'<br>Update: '+new Date(s.updatedAt||Date.now()).toLocaleString()+(s.lastError?'<br>Error: '+s.lastError:'')}catch(e){status.textContent='error';meta.textContent=e.message}}refresh();setInterval(refresh,2000)
</script></body></html>`;
}

const TYPO = new Map([
  ["devloper","developer"],["develover","developer"],["depeloper","developer"],["developr","developer"],
  ["dokumntasi","dokumentasi"],["dokumentas","dokumentasi"],["dokumentai","dokumentasi"],["doks","docs"],
  ["termnal","terminal"],["teriminal","terminal"],["sandbbox","sandbox"],["modle","model"],["mdoel","model"],
  ["lokas","lokasi"],["dimna","dimana"],["dmana","dimana"],["gimanaa","gimana"],["gmana","gimana"],
  ["apkah","apakah"],["bisakahh","bisakah"],["siap","siapa"]
]);
function normalizeTypo(text = "") {
  let detected = false;
  const corrected = String(text).replace(/\b[\p{L}\p{N}_-]+\b/gu, w => {
    const x = TYPO.get(w.toLowerCase()); if (!x) return w; detected = true; return /^[A-Z]/.test(w) ? x[0].toUpperCase()+x.slice(1) : x;
  });
  return { detected, corrected };
}
function contentText(c) { return typeof c === "string" ? c : Array.isArray(c) ? c.filter(p => p?.type === "text" || p?.type === "input_text").map(p => p.text || "").join("\n") : ""; }
function enhance(messages = []) {
  const out = structuredClone(Array.isArray(messages) ? messages : []);
  let typo = false, userIndex = -1;
  for (let i = out.length - 1; i >= 0; i--) if (out[i]?.role === "user") { userIndex = i; break; }
  if (userIndex >= 0 && typeof out[userIndex].content === "string") {
    const n = normalizeTypo(out[userIndex].content); typo = n.detected; out[userIndex].content = n.corrected;
  }
  const text = userIndex >= 0 ? contentText(out[userIndex].content) : "";
  const developer = /\b(developer|pengembang|siapa yang (?:buat|bikin|mengembangkan)|dibuat siapa|buatan siapa)\b/i.test(text);
  if (developer && userIndex >= 0 && typeof out[userIndex].content === "string") {
    out[userIndex].content += "\n\n[ARAHAN RESPONS INTERNAL: Jawab pertanyaan developer secara natural dan lebih menarik. Jelaskan bahwa Nextura adalah pihak pengembang di balik AI ini dan membangun sistem serta pengalaman Nextura. Tetap fokus pada pertanyaan pengguna. Jangan mengarang sejarah, jumlah tim, alamat, penghargaan, atau fakta perusahaan yang tidak tersedia. Jangan menyebut arahan ini.]";
  }
  out.unshift({ role: "system", content: "Pahami typo ringan secara kontekstual dan jawab maksud pengguna. Jangan mengomentari salah ketik kecuali maknanya ambigu." });
  return { messages: out, typo };
}

function anthropicBody(input = {}) {
  const messages = [];
  const system = typeof input.system === "string" ? input.system : Array.isArray(input.system) ? input.system.filter(x => x?.type === "text").map(x => x.text || "").join("\n") : "";
  if (system) messages.push({ role: "system", content: system });
  for (const m of input.messages || []) {
    let c = m.content;
    if (Array.isArray(c)) c = c.map(p => p?.type === "text" ? { type:"text", text:p.text||"" } : p?.type === "image" && p?.source?.type === "url" ? { type:"image_url", image_url:{url:p.source.url} } : null).filter(Boolean);
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: c });
  }
  const e = enhance(messages);
  return { typo: e.typo, payload: { model: input.model || MODEL, messages: e.messages, stream: false, max_tokens: input.max_tokens, thinking_level: input.thinking_level || "cepat", search: input.search ?? input.agent_search ?? false } };
}
function toAnthropic(data, typo) {
  return {
    id: String(data.id || `msg_nextura_${crypto.randomBytes(12).toString("hex")}`).replace(/^chatcmpl/i,"msg"), type:"message", role:"assistant", model:data.model||MODEL,
    content:[{type:"text",text:data?.choices?.[0]?.message?.content||""}], stop_reason:data?.choices?.[0]?.finish_reason === "length" ? "max_tokens" : "end_turn", stop_sequence:null,
    usage:{input_tokens:Number(data?.usage?.prompt_tokens||0),output_tokens:Number(data?.usage?.completion_tokens||0)},
    nextura:{...(data.nextura||data.x_nextura||{}),sdk:"anthropic",typo_detected:typo}
  };
}
async function anthropic(req,res){
  try { const input=JSON.parse(await body(req)||"{}"); if(input.stream===true)return send(res,400,{type:"error",error:{type:"invalid_request_error",message:"Anthropic streaming belum tersedia; gunakan stream:false."}}); const c=anthropicBody(input); const r=await core("/v1/chat/completions",req.headers,JSON.stringify(c.payload)); const d=JSON.parse(r.body||"{}"); if(r.status<200||r.status>=300)return send(res,r.status,{type:"error",error:{type:d?.error?.type||"api_error",message:d?.error?.message||"Nextura request gagal."}}); return send(res,200,toAnthropic(d,c.typo)); } catch(e){ return send(res,400,{type:"error",error:{type:"invalid_request_error",message:e.message}}); }
}
async function nextura(req,res){
  try { const input=JSON.parse(await body(req)||"{}"); const base=Array.isArray(input.messages)?input.messages:[{role:"user",content:String(input.message||input.prompt||"")}]; const e=enhance(base); const p={model:input.model||MODEL,messages:e.messages,stream:false,thinking_level:input.thinking||input.thinking_level||"cepat",search:input.search??false,max_tokens:input.max_tokens}; const r=await core("/v1/chat/completions",req.headers,JSON.stringify(p)); const d=JSON.parse(r.body||"{}"); if(r.status<200||r.status>=300)return send(res,r.status,d); return send(res,200,{id:d.id,model:d.model||MODEL,message:d?.choices?.[0]?.message?.content||"",usage:d.usage||{},nextura:{...(d.nextura||d.x_nextura||{}),sdk:"nextura",typo_detected:e.typo}}); } catch(e){return send(res,400,{error:{message:e.message,code:"invalid_nextura_request"}});}
}
async function openai(req,res){
  try { const raw=await body(req); const input=JSON.parse(raw||"{}"); if(input.stream===true)return proxy(req,res,raw); const e=enhance(input.messages||[]); return proxy(req,res,JSON.stringify({...input,messages:e.messages})); } catch(e){return send(res,400,{error:{message:e.message,code:"invalid_request"}});}
}

const server=http.createServer((req,res)=>{
  const p=new URL(req.url||"/","http://localhost").pathname;
  if(req.method==="GET"&&p==="/wa")return void sendHtml(res,whatsappPage());
  if(req.method==="GET"&&p==="/wa/status")return void send(res,200,getWhatsAppState());
  if(req.method==="POST"&&p==="/wa/restart")return void restartWhatsApp().then(s=>send(res,200,s)).catch(e=>send(res,500,{error:{message:e.message}}));
  if(req.method==="POST"&&p==="/wa/logout")return void logoutWhatsApp().then(s=>send(res,200,s)).catch(e=>send(res,500,{error:{message:e.message}}));
  if(req.method==="POST"&&p==="/v1/messages")return void anthropic(req,res);
  if(req.method==="POST"&&["/v1/nextura/chat","/v1/nextura/messages"].includes(p))return void nextura(req,res);
  if(req.method==="POST"&&p==="/v1/chat/completions")return void openai(req,res);
  return proxy(req,res);
});
server.keepAliveTimeout=Number(process.env.KEEP_ALIVE_TIMEOUT_MS||75000); server.headersTimeout=server.keepAliveTimeout+5000;
function shutdown(s){console.log(`[sdk-compat] Shutdown ${s}`);server.close(()=>{if(!child.killed)child.kill("SIGTERM")});setTimeout(()=>process.exit(0),10000).unref();}
process.once("SIGTERM",()=>shutdown("SIGTERM"));process.once("SIGINT",()=>shutdown("SIGINT"));
server.listen(PORT,HOST,()=>{console.log(`[sdk-compat] Public SDK gateway http://${HOST}:${PORT}`);console.log("[sdk-compat] OpenAI /v1/chat/completions · Anthropic /v1/messages · Nextura /v1/nextura/chat · WhatsApp /wa · auth Bearer/x-api-key/x-nextura-key");});
