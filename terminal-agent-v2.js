import http from "node:http";
import { spawn } from "node:child_process";

const PUBLIC_PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";
const GATEWAY_PORT = Number(process.env.NEXTURA_GATEWAY_PORT || (PUBLIC_PORT === 8000 ? 8010 : PUBLIC_PORT + 10));
const MAX_BODY = Number(process.env.BODY_LIMIT_BYTES || 10 * 1024 * 1024);
const TOOL_ENABLED = String(process.env.ENABLE_TERMINAL_TOOL || "false").toLowerCase() === "true";
const TOOL_KEY = process.env.NEXTURA_TOOL_KEY || process.env.NEXTURA_API_KEY || "";
const MAX_ACTIONS = Math.max(1, Math.min(Number(process.env.TERMINAL_AGENT_MAX_ACTIONS || 6), 8));

const child = spawn(process.execPath, ["nextura-gateway.js"], {
  env: { ...process.env, PORT: String(GATEWAY_PORT), HOST: "127.0.0.1" },
  stdio: "inherit"
});
child.on("exit", (code, signal) => { console.error(`[terminal-agent] gateway berhenti. code=${code} signal=${signal}`); process.exit(code ?? 1); });

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new Error("Payload terlalu besar"); chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8");
}

function requestInternal(pathname, method, headers, body = null) {
  return new Promise((resolve, reject) => {
    const outHeaders = { ...headers, host: `127.0.0.1:${GATEWAY_PORT}` };
    if (body !== null) { outHeaders["content-type"] = "application/json"; outHeaders["content-length"] = Buffer.byteLength(body); delete outHeaders["transfer-encoding"]; }
    const request = http.request({ hostname: "127.0.0.1", port: GATEWAY_PORT, path: pathname, method, headers: outHeaders }, (resp) => {
      const chunks = []; resp.on("data", (c) => chunks.push(c)); resp.on("end", () => resolve({ status: resp.statusCode || 502, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject); if (body !== null) request.end(body); else request.end();
  });
}

function proxy(req, res, body = null) {
  const headers = { ...req.headers, host: `127.0.0.1:${GATEWAY_PORT}` };
  if (body !== null) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(body); delete headers["transfer-encoding"]; }
  const upstream = http.request({ hostname: "127.0.0.1", port: GATEWAY_PORT, path: req.url, method: req.method, headers }, (upstreamRes) => { res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers); upstreamRes.pipe(res); });
  upstream.on("error", (error) => sendJson(res, 502, { error: { message: "Nextura gateway belum siap.", code: "gateway_unavailable", detail: error.message } }));
  if (body !== null) upstream.end(body); else req.pipe(upstream);
}

function latestUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]; if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.filter((p) => p?.type === "text" || p?.type === "input_text").map((p) => p.text || "").join("\n");
  }
  return "";
}

function wantsTerminal(text = "") {
  return /\b(terminal|sandbox|jalankan|run|execute|eksekusi|buat\s+(?:file|kode|code|script|pdf)|tulis\s+(?:file|kode|code)|simpan\s+(?:file|kode|code|pdf)|baca\s+file|lihat\s+file|list\s+file|cek\s+file|test\s+code|uji\s+kode|node(?:\.js)?|javascript|npm|git|pdf|download|unduh|screenshot|screen\s*shot|ss\s+web|tangkap\s+layar|gambar\s+dari\s+link)\b/i.test(text);
}

function extractJson(text = "") {
  const raw = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf("{"); const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) { try { return JSON.parse(raw.slice(start, end + 1)); } catch {} }
  return null;
}

function normalizePlan(plan) {
  const allowed = new Set(["sandbox_write", "sandbox_read", "sandbox_list", "sandbox_run_js", "sandbox_download", "sandbox_pdf", "sandbox_screenshot"]);
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  return actions.slice(0, MAX_ACTIONS).filter((a) => allowed.has(String(a?.action || ""))).map((a) => ({
    action: String(a.action),
    path: typeof a.path === "string" ? a.path : undefined,
    content: typeof a.content === "string" ? a.content : undefined,
    text: typeof a.text === "string" ? a.text : undefined,
    title: typeof a.title === "string" ? a.title : undefined,
    code: typeof a.code === "string" ? a.code : undefined,
    url: typeof a.url === "string" ? a.url : undefined,
    width: Number.isFinite(Number(a.width)) ? Number(a.width) : undefined,
    height: Number.isFinite(Number(a.height)) ? Number(a.height) : undefined,
    full_page: typeof a.full_page === "boolean" ? a.full_page : undefined,
    font_size: Number.isFinite(Number(a.font_size)) ? Number(a.font_size) : undefined,
    timeout_ms: Number.isFinite(Number(a.timeout_ms)) ? Math.min(Number(a.timeout_ms), 120000) : undefined
  }));
}

async function planTerminal(input, headers) {
  const plannerSystem = `Kamu adalah planner untuk Nextura Sandbox Terminal. Tentukan tool sandbox yang benar-benar diperlukan untuk memenuhi permintaan user.\n\nTool tersedia:\n- sandbox_write: buat/timpa file teks, JS, JSON, HTML, CSS, MD, dll. Parameter path, content.\n- sandbox_read: baca file teks atau cek metadata file binary. Parameter path.\n- sandbox_list: daftar file/folder. Parameter path opsional.\n- sandbox_run_js: jalankan JavaScript. Parameter path file .js/.mjs ATAU code.\n- sandbox_download: download file/gambar dari URL HTTPS publik ke sandbox. Parameter url, path opsional.\n- sandbox_pdf: buat PDF dari teks. Parameter path .pdf, content/text, title opsional.\n- sandbox_screenshot: screenshot website HTTPS publik dengan browser headless. Parameter url, path .png/.jpg, width, height, full_page opsional.\n\nAturan wajib:\n1. Semua artifact harus berada di sandbox, tidak boleh path absolut atau ../.\n2. Jangan pernah merencanakan delete/rm/unlink/rmdir/format/wipe.\n3. Maksimal ${MAX_ACTIONS} action.\n4. Jika user hanya bertanya kemampuan, actions kosong.\n5. Buat lalu jalankan JS: sandbox_write lalu sandbox_run_js.\n6. Jika user minta PDF, gunakan sandbox_pdf langsung; jangan pakai JS kecuali memang perlu logika khusus.\n7. Jika user minta download gambar/file dari link, gunakan sandbox_download.\n8. Jika user minta screenshot/SS web, gunakan sandbox_screenshot.\n9. Jangan memakai curl untuk menggantikan tool download/screenshot jika tool khusus tersedia.\n10. Keluarkan JSON valid saja: {"actions":[...]}.`;

  const plannerBody = { model: input.model || "Nextura/cortexa-max", messages: [{ role: "system", content: plannerSystem }, ...(Array.isArray(input.messages) ? input.messages : [])], thinking_level: "cepat", search: false, agent_search: false, review: false, stream: false, max_tokens: 2200 };
  const response = await requestInternal("/v1/chat/completions", "POST", headers, JSON.stringify(plannerBody));
  if (response.status < 200 || response.status >= 300) return [];
  let data; try { data = JSON.parse(response.body); } catch { return []; }
  return normalizePlan(extractJson(data?.choices?.[0]?.message?.content || ""));
}

function toolHeaders() { return { authorization: `Bearer ${TOOL_KEY}`, "content-type": "application/json" }; }

async function executeSandbox(actions) {
  const results = [];
  if (!TOOL_KEY) return [{ action: "sandbox", status: 503, result: { error: { message: "NEXTURA_TOOL_KEY belum dikonfigurasi." } } }];
  for (const action of actions) {
    const response = await requestInternal("/v1/tools/sandbox", "POST", toolHeaders(), JSON.stringify(action));
    let data; try { data = JSON.parse(response.body); } catch { data = { raw: response.body.slice(0, 20000) }; }
    results.push({ action: action.action, request: { path: action.path, url: action.url }, status: response.status, result: data });
    if (response.status < 200 || response.status >= 300) break;
  }
  return results;
}

async function handleChat(req, res) {
  try {
    const raw = await readBody(req); const input = raw ? JSON.parse(raw) : {}; const text = latestUserText(input.messages || []);
    if (!TOOL_ENABLED || input.stream === true || !wantsTerminal(text)) return proxy(req, res, raw || "{}");

    const actions = await planTerminal(input, req.headers);
    if (!actions.length) {
      const messages = [{ role: "system", content: "Kamu memiliki Nextura Sandbox Terminal nyata. Kamu dapat membuat/membaca file, menjalankan JavaScript, membuat PDF, download file/gambar HTTPS, dan screenshot website publik. Jangan mengklaim operasi sudah dilakukan bila tool belum menghasilkan hasil." }, ...(input.messages || [])];
      return proxy(req, res, JSON.stringify({ ...input, messages }));
    }

    const results = await executeSandbox(actions);
    const toolContext = { service: "Nextura Sandbox Terminal", sandboxed: true, deletion_available_to_ai: false, actions: results };
    const messages = [{ role: "system", content: `NEXTURA SANDBOX TERMINAL SUDAH DIGUNAKAN. Hasil tool nyata:\n${JSON.stringify(toolContext)}\n\nJawab berdasarkan hasil aktual. Jika artifact berhasil dibuat/download/screenshot, sebutkan nama/path filenya. Jangan mengarang keberhasilan. Jangan mengklaim file tersedia di perangkat user; file berada di sandbox Nextura.` }, ...(input.messages || [])];
    const finalResponse = await requestInternal("/v1/chat/completions", "POST", req.headers, JSON.stringify({ ...input, messages, stream: false }));
    let finalData; try { finalData = JSON.parse(finalResponse.body); } catch { res.writeHead(finalResponse.status, finalResponse.headers); return res.end(finalResponse.body); }
    const actionMeta = results.map((r) => ({ action: r.action, status: r.status, path: r.result?.path || null }));
    if (finalData?.nextura) { finalData.nextura.tool_used = "nextura_sandbox_terminal"; finalData.nextura.terminal_actions = actionMeta; }
    if (finalData?.x_nextura) { finalData.x_nextura.tool_used = "nextura_sandbox_terminal"; finalData.x_nextura.terminal_actions = actionMeta; }
    return sendJson(res, finalResponse.status, finalData);
  } catch (error) { return sendJson(res, 400, { error: { message: error.message || "Terminal agent gagal memproses request.", code: "terminal_agent_failed" } }); }
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname.startsWith("/v1/tools/")) return sendJson(res, 404, { error: { message: "Endpoint tool bersifat internal Nextura.", code: "internal_tool" } });
  if (req.method === "POST" && pathname === "/v1/chat/completions") return void handleChat(req, res);
  return proxy(req, res);
});

server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 75000);
server.headersTimeout = server.keepAliveTimeout + 5000;
function shutdown(signal) { console.log(`[terminal-agent] Shutdown ${signal}`); server.close(() => { if (!child.killed) child.kill("SIGTERM"); }); setTimeout(() => process.exit(0), 10000).unref(); }
process.once("SIGTERM", () => shutdown("SIGTERM")); process.once("SIGINT", () => shutdown("SIGINT"));
server.listen(PUBLIC_PORT, HOST, () => { console.log(`[terminal-agent] Nextura public gateway v2 online di http://${HOST}:${PUBLIC_PORT}`); console.log(`[terminal-agent] Internal gateway di http://127.0.0.1:${GATEWAY_PORT}`); console.log(`[terminal-agent] Sandbox terminal agent enabled=${TOOL_ENABLED}`); });
