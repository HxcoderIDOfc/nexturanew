import http from "node:http";
import { spawn } from "node:child_process";

const PUBLIC_PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";
const GATEWAY_PORT = Number(process.env.NEXTURA_GATEWAY_PORT || (PUBLIC_PORT === 8000 ? 8010 : PUBLIC_PORT + 10));
const MAX_BODY = Number(process.env.BODY_LIMIT_BYTES || 10 * 1024 * 1024);
const TOOL_ENABLED = String(process.env.ENABLE_TERMINAL_TOOL || "false").toLowerCase() === "true";
const TOOL_KEY = process.env.NEXTURA_TOOL_KEY || process.env.NEXTURA_API_KEY || "";
const MAX_ACTIONS = Math.max(1, Math.min(Number(process.env.TERMINAL_AGENT_MAX_ACTIONS || 4), 6));

const child = spawn(process.execPath, ["nextura-gateway.js"], {
  env: { ...process.env, PORT: String(GATEWAY_PORT), HOST: "127.0.0.1" },
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  console.error(`[terminal-agent] gateway berhenti. code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Payload terlalu besar");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requestInternal(pathname, method, headers, body = null) {
  return new Promise((resolve, reject) => {
    const outHeaders = { ...headers, host: `127.0.0.1:${GATEWAY_PORT}` };
    if (body !== null) {
      outHeaders["content-type"] = "application/json";
      outHeaders["content-length"] = Buffer.byteLength(body);
      delete outHeaders["transfer-encoding"];
    }
    const req = http.request({ hostname: "127.0.0.1", port: GATEWAY_PORT, path: pathname, method, headers: outHeaders }, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => resolve({ status: resp.statusCode || 502, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== null) req.end(body); else req.end();
  });
}

function proxy(req, res, body = null) {
  const headers = { ...req.headers, host: `127.0.0.1:${GATEWAY_PORT}` };
  if (body !== null) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body);
    delete headers["transfer-encoding"];
  }
  const upstream = http.request({ hostname: "127.0.0.1", port: GATEWAY_PORT, path: req.url, method: req.method, headers }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", (error) => sendJson(res, 502, { error: { message: "Nextura gateway belum siap.", code: "gateway_unavailable", detail: error.message } }));
  if (body !== null) upstream.end(body); else req.pipe(upstream);
}

function latestUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.filter((p) => p?.type === "text" || p?.type === "input_text").map((p) => p.text || "").join("\n");
  }
  return "";
}

function wantsTerminal(text = "") {
  return /\b(terminal|sandbox|jalankan|run|execute|eksekusi|buat\s+(?:file|kode|code|script)|tulis\s+(?:file|kode|code)|simpan\s+(?:file|kode|code)|baca\s+file|lihat\s+file|list\s+file|cek\s+file|test\s+code|uji\s+kode|node(?:\.js)?|javascript|npm|git)\b/i.test(text);
}

function extractJson(text = "") {
  const raw = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

function normalizePlan(plan) {
  const allowed = new Set(["sandbox_write", "sandbox_read", "sandbox_list", "sandbox_run_js"]);
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  return actions.slice(0, MAX_ACTIONS).filter((a) => allowed.has(String(a?.action || ""))).map((a) => ({
    action: String(a.action),
    path: typeof a.path === "string" ? a.path : undefined,
    content: typeof a.content === "string" ? a.content : undefined,
    code: typeof a.code === "string" ? a.code : undefined,
    timeout_ms: Number.isFinite(Number(a.timeout_ms)) ? Math.min(Number(a.timeout_ms), 120000) : undefined
  }));
}

async function planTerminal(input, headers) {
  const plannerSystem = `Kamu adalah planner untuk Nextura Sandbox Terminal. Tentukan tool sandbox yang benar-benar diperlukan untuk memenuhi permintaan user.\n\nTool yang tersedia:\n- sandbox_write: buat/timpa file di sandbox. Parameter path dan content.\n- sandbox_read: baca file sandbox. Parameter path.\n- sandbox_list: daftar file/folder sandbox. Parameter path opsional.\n- sandbox_run_js: jalankan JavaScript di sandbox. Parameter path file .js/.mjs ATAU code.\n\nAturan wajib:\n1. Sandbox adalah terminal milik Nextura sendiri, terisolasi dari host utama.\n2. Jangan pernah merencanakan delete, rm, unlink, rmdir, format, wipe, atau penghapusan apa pun.\n3. Jangan mengakses path absolut atau ../. Semua path relatif terhadap sandbox.\n4. Maksimal ${MAX_ACTIONS} action.\n5. Jika user hanya bertanya kemampuan terminal tanpa meminta operasi nyata, actions harus kosong.\n6. Untuk membuat lalu menjalankan kode, gunakan sandbox_write lalu sandbox_run_js.\n7. Keluarkan JSON valid saja tanpa markdown: {"actions":[...]}.`;

  const plannerBody = {
    model: input.model || "Nextura/cortexa-max",
    messages: [{ role: "system", content: plannerSystem }, ...(Array.isArray(input.messages) ? input.messages : [])],
    thinking_level: "cepat",
    search: false,
    agent_search: false,
    review: false,
    stream: false,
    max_tokens: 1800
  };

  const response = await requestInternal("/v1/chat/completions", "POST", headers, JSON.stringify(plannerBody));
  if (response.status < 200 || response.status >= 300) return [];
  let data;
  try { data = JSON.parse(response.body); } catch { return []; }
  const content = data?.choices?.[0]?.message?.content || "";
  return normalizePlan(extractJson(content));
}

function toolHeaders() {
  return {
    authorization: `Bearer ${TOOL_KEY}`,
    "content-type": "application/json"
  };
}

async function executeSandbox(actions) {
  const results = [];
  if (!TOOL_KEY) return [{ action: "sandbox", status: 503, result: { error: { message: "NEXTURA_TOOL_KEY belum dikonfigurasi." } } }];

  for (const action of actions) {
    const response = await requestInternal("/v1/tools/sandbox", "POST", toolHeaders(), JSON.stringify(action));
    let data;
    try { data = JSON.parse(response.body); } catch { data = { raw: response.body.slice(0, 20000) }; }
    results.push({ action: action.action, request: { path: action.path }, status: response.status, result: data });
    if (response.status < 200 || response.status >= 300) break;
  }
  return results;
}

async function handleChat(req, res) {
  try {
    const raw = await readBody(req);
    const input = raw ? JSON.parse(raw) : {};
    const text = latestUserText(input.messages || []);

    if (!TOOL_ENABLED || input.stream === true || !wantsTerminal(text)) {
      return proxy(req, res, raw || "{}");
    }

    const actions = await planTerminal(input, req.headers);
    if (!actions.length) {
      const messages = [
        { role: "system", content: "Kamu memiliki Nextura Sandbox Terminal yang nyata. Terminal ini terisolasi dari host utama. Kamu dapat membuat, membaca, melihat daftar file, dan menjalankan JavaScript di sandbox ketika tool benar-benar digunakan. Jangan mengatakan bahwa kamu tidak punya terminal. Jangan mengklaim sudah menjalankan sesuatu jika tidak ada hasil tool." },
        ...(input.messages || [])
      ];
      return proxy(req, res, JSON.stringify({ ...input, messages }));
    }

    const results = await executeSandbox(actions);
    const toolContext = {
      service: "Nextura Sandbox Terminal",
      sandboxed: true,
      deletion_available_to_ai: false,
      actions: results
    };

    const messages = [
      {
        role: "system",
        content: `NEXTURA SANDBOX TERMINAL SUDAH DIGUNAKAN. Berikut hasil eksekusi tool yang nyata:\n${JSON.stringify(toolContext)}\n\nJawab permintaan user berdasarkan hasil aktual di atas. Sebut terminal ini sebagai Nextura Sandbox Terminal atau terminal sandbox milikmu. Jangan mengatakan kamu tidak punya terminal. Jangan mengarang keberhasilan yang tidak ada di hasil tool. Penghapusan file tidak tersedia untuk AI secara otomatis.`
      },
      ...(input.messages || [])
    ];

    const finalBody = JSON.stringify({ ...input, messages, stream: false });
    const finalResponse = await requestInternal("/v1/chat/completions", "POST", req.headers, finalBody);
    let finalData;
    try { finalData = JSON.parse(finalResponse.body); } catch {
      res.writeHead(finalResponse.status, finalResponse.headers);
      return res.end(finalResponse.body);
    }

    if (finalData?.nextura) {
      finalData.nextura.tool_used = "nextura_sandbox_terminal";
      finalData.nextura.terminal_actions = results.map((r) => ({ action: r.action, status: r.status }));
    }
    if (finalData?.x_nextura) {
      finalData.x_nextura.tool_used = "nextura_sandbox_terminal";
      finalData.x_nextura.terminal_actions = results.map((r) => ({ action: r.action, status: r.status }));
    }

    return sendJson(res, finalResponse.status, finalData);
  } catch (error) {
    return sendJson(res, 400, { error: { message: error.message || "Terminal agent gagal memproses request.", code: "terminal_agent_failed" } });
  }
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  // Tool internal tidak dibuka ke internet. AI mengaksesnya melalui loop internal di atas.
  if (pathname.startsWith("/v1/tools/")) {
    return sendJson(res, 404, { error: { message: "Endpoint tool bersifat internal Nextura.", code: "internal_tool" } });
  }

  if (req.method === "POST" && pathname === "/v1/chat/completions") return void handleChat(req, res);
  return proxy(req, res);
});

server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 75000);
server.headersTimeout = server.keepAliveTimeout + 5000;

function shutdown(signal) {
  console.log(`[terminal-agent] Shutdown ${signal}`);
  server.close(() => { if (!child.killed) child.kill("SIGTERM"); });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

server.listen(PUBLIC_PORT, HOST, () => {
  console.log(`[terminal-agent] Nextura public gateway online di http://${HOST}:${PUBLIC_PORT}`);
  console.log(`[terminal-agent] Internal gateway di http://127.0.0.1:${GATEWAY_PORT}`);
  console.log(`[terminal-agent] Sandbox terminal agent enabled=${TOOL_ENABLED}`);
});
