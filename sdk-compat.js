import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

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
  if(req.method==="POST"&&p==="/v1/messages")return void anthropic(req,res);
  if(req.method==="POST"&&["/v1/nextura/chat","/v1/nextura/messages"].includes(p))return void nextura(req,res);
  if(req.method==="POST"&&p==="/v1/chat/completions")return void openai(req,res);
  return proxy(req,res);
});
server.keepAliveTimeout=Number(process.env.KEEP_ALIVE_TIMEOUT_MS||75000); server.headersTimeout=server.keepAliveTimeout+5000;
function shutdown(s){console.log(`[sdk-compat] Shutdown ${s}`);server.close(()=>{if(!child.killed)child.kill("SIGTERM")});setTimeout(()=>process.exit(0),10000).unref();}
process.once("SIGTERM",()=>shutdown("SIGTERM"));process.once("SIGINT",()=>shutdown("SIGINT"));
server.listen(PORT,HOST,()=>{console.log(`[sdk-compat] Public SDK gateway http://${HOST}:${PORT}`);console.log("[sdk-compat] OpenAI /v1/chat/completions · Anthropic /v1/messages · Nextura /v1/nextura/chat · auth Bearer/x-api-key/x-nextura-key");});
