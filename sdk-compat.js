import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";
const CORE_PORT = Number(process.env.SDK_CORE_PORT || (PORT === 8000 ? 8020 : PORT + 20));
const BODY_LIMIT = Number(process.env.BODY_LIMIT_BYTES || 10 * 1024 * 1024);
const MODEL = process.env.NEXTURA_MAX_MODEL_ID || "Nextura/cortexa-max";

const child = spawn(process.execPath, ["terminal-agent.js"], {
  env: { ...process.env, PORT: String(CORE_PORT), HOST: "127.0.0.1" },
  stdio: "inherit"
});
child.on("exit", (code, signal) => {
  console.error(`[sdk-compat] core berhenti. code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

function sendJson(res, status, payload) {
  const raw = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(raw),
    "cache-control": "no-store"
  });
  res.end(raw);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error("Payload terlalu besar");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizedHeaders(headers = {}) {
  const out = { ...headers, host: `127.0.0.1:${CORE_PORT}` };
  const xKey = String(headers["x-api-key"] || headers["x-nextura-key"] || "").trim();
  if (!out.authorization && xKey) out.authorization = `Bearer ${xKey}`;
  return out;
}

function proxy(req, res, options = {}) {
  const path = options.path || req.url;
  const method = options.method || req.method;
  const body = options.body;
  const headers = normalizedHeaders(req.headers);
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body);
    delete headers["transfer-encoding"];
  }
  const upstream = http.request({ hostname: "127.0.0.1", port: CORE_PORT, path, method, headers }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", (error) => sendJson(res, 502, { error: { message: "Nextura core belum siap.", code: "core_unavailable", detail: error.message } }));
  if (body !== undefined) upstream.end(body); else req.pipe(upstream);
}

function requestCore(path, headers, body) {
  return new Promise((resolve, reject) => {
    const outHeaders = normalizedHeaders(headers);
    outHeaders["content-type"] = "application/json";
    outHeaders["content-length"] = Buffer.byteLength(body);
    delete outHeaders["transfer-encoding"];
    const request = http.request({ hostname: "127.0.0.1", port: CORE_PORT, path, method: "POST", headers: outHeaders }, (response) => {
      const chunks = [];
      response.on("data", (c) => chunks.push(c));
      response.on("end", () => resolve({ status: response.statusCode || 502, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

const TYPO_MAP = new Map([
  ["devloper", "developer"], ["develover", "developer"], ["depeloper", "developer"],
  ["dokumntasi", "dokumentasi"], ["dokumentas", "dokumentasi"], ["dokumentai", "dokumentasi"],
  ["termnal", "terminal"], ["teriminal", "terminal"], ["sandbbox", "sandbox"],
  ["modle", "model"], ["mdoel", "model"], ["lokas", "lokasi"],
  ["dimna", "dimana"], ["dmana", "dimana"], ["gimanaa", "gimana"], ["gmana", "gimana"],
  ["bikinan", "buatan"], ["apkah", "apakah"], ["bisakahh", "bisakah"]
]);

function typoNormalize(text = "") {
  let detected = false;
  const corrected = String(text).replace(/\b[\p{L}\p{N}_-]+\b/gu, (word) => {
    const replacement = TYPO_MAP.get(word.toLowerCase());
    if (!replacement) return word;
    detected = true;
    return /^[A-Z]/.test(word) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
  });
  return { detected, corrected };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p?.type === "text" || p?.type === "input_text").map((p) => p.text || "").join("\n");
}

function enhanceMessages(messages = []) {
  const next = structuredClone(Array.isArray(messages) ? messages : []);
  let typoDetected = false;
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]?.role !== "user") continue;
    if (typeof next[i].content === "string") {
      const normalized = typoNormalize(next[i].content);
      typoDetected = normalized.detected;
      if (normalized.detected) next[i].content = normalized.corrected;
    }
    break;
  }
  const lastUser = [...next].reverse().find((m) => m?.role === "user");
  const lastText = textOf(lastUser?.content);
  const asksDeveloper = /\b(developer|pengembang|siapa yang (?:buat|bikin|mengembangkan)|dibuat siapa|buatan siapa)\b/i.test(lastText);
  const prompt = [
    "Pahami typo ringan pengguna secara kontekstual. Jangan membahas atau mengoreksi ejaan kecuali makna benar-benar ambigu. Jawab maksud pengguna, bukan salah ketiknya."
  ];
  if (asksDeveloper) prompt.push("Jika pengguna menanyakan developer/pengembang, jelaskan Nextura dengan gaya menarik dan natural: bahwa Nextura adalah pihak pengembang di balik AI ini dan membangun pengalaman serta sistem Nextura. Jangan mengarang sejarah, ukuran tim, alamat, penghargaan, atau fakta perusahaan yang tidak tersedia. Jangan membacakan profil lengkap kecuali diminta.");
  next.unshift({ role: "system", content: prompt.join("\n") });
  return { messages: next, typoDetected };
}

function anthropicToOpenAI(input = {}) {
  const messages = [];
  if (typeof input.system === "string" && input.system.trim()) messages.push({ role: "system", content: input.system });
  else if (Array.isArray(input.system)) {
    const systemText = input.system.filter((p) => p?.type === "text").map((p) => p.text || "").join("\n");
    if (systemText) messages.push({ role: "system", content: systemText });
  }
  for (const message of input.messages || []) {
    let content = message.content;
    if (Array.isArray(content)) {
      content = content.map((part) => {
        if (part?.type === "text") return { type: "text", text: part.text || "" };
        if (part?.type === "image" && part?.source?.type === "url") return { type: "image_url", image_url: { url: part.source.url } };
        return null;
      }).filter(Boolean);
    }
    messages.push({ role: message.role === "assistant" ? "assistant" : "user", content });
  }
  const enhanced = enhanceMessages(messages);
  return {
    body: {
      model: input.model || MODEL,
      messages: enhanced.messages,
      max_tokens: input.max_tokens,
      stream: false,
      thinking_level: input.thinking_level || "cepat",
      search: input.search ?? input.agent_search ?? false
    },
    typoDetected: enhanced.typoDetected
  };
}

function openAIToAnthropic(data = {}, typoDetected = false) {
  const text = data?.choices?.[0]?.message?.content || "";
  const usage = data?.usage || {};
  return {
    id: String(data.id || `msg_nextura_${crypto.randomBytes(12).toString("hex")}`).replace(/^chatcmpl/i, "msg"),
    type: "message",
    role: "assistant",
    model: data.model || MODEL,
    content: [{ type: "text", text }],
    stop_reason: data?.choices?.[0]?.finish_reason === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens || 0),
      output_tokens: Number(usage.completion_tokens || 0)
    },
    nextura: { ...(data.nextura || data.x_nextura || {}), sdk: "anthropic", typo_detected: typoDetected }
  };
}

async function handleAnthropic(req, res) {
  try {
    const raw = await readBody(req);
    const input = raw ? JSON.parse(raw) : {};
    if (input.stream === true) return sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Anthropic-compatible streaming belum tersedia pada endpoint /v1/messages. Gunakan stream:false." } });
    const converted = anthropicToOpenAI(input);
    const response = await requestCore("/v1/chat/completions", req.headers, JSON.stringify(converted.body));
    let data;
    try { data = JSON.parse(response.body); } catch { return sendJson(res, 502, { type: "error", error: { type: "api_error", message: "Respons Nextura tidak valid." } }); }
    if (response.status < 200 || response.status >= 300) return sendJson(res, response.status, { type: "error", error: { type: data?.error?.type || "api_error", message: data?.error?.message || "Nextura request gagal." } });
    return sendJson(res, 200, openAIToAnthropic(data, converted.typoDetected));
  } catch (error) {
    return sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: error.message || "Payload Anthropic tidak valid." } });
  }
}

async function handleNextura(req, res) {
  try {
    const raw = await readBody(req);
    const input = raw ? JSON.parse(raw) : {};
    const baseMessages = Array.isArray(input.messages) ? input.messages : [{ role: "user", content: String(input.message || input.prompt || "") }];
    const enhanced = enhanceMessages(baseMessages);
    const body = {
      model: input.model || MODEL,
      messages: enhanced.messages,
      stream: false,
      thinking_level: input.thinking || input.thinking_level || "cepat",
      search: input.search ?? false,
      max_tokens: input.max_tokens
    };
    const response = await requestCore("/v1/chat/completions", req.headers, JSON.stringify(body));
    let data;
    try { data = JSON.parse(response.body); } catch { return sendJson(res, 502, { error: { message: "Respons Nextura core tidak valid.", code: "invalid_core_response" } }); }
    if (response.status < 200 || response.status >= 300) return sendJson(res, response.status, data);
    return sendJson(res, 200, {
      id: data.id,
      model: data.model || MODEL,
      message: data?.choices?.[0]?.message?.content || "",
      usage: data.usage || {},
      nextura: { ...(data.nextura || data.x_nextura || {}), sdk: "nextura", typo_detected: enhanced.typoDetected }
    });
  } catch (error) {
    return sendJson(res, 400, { error: { message: error.message || "Payload Nextura tidak valid.", code: "invalid_nextura_request" } });
  }
}

async function handleOpenAI(req, res) {
  try {
    const raw = await readBody(req);
    if (!raw) return proxy(req, res, { body: "{}" });
    const input = JSON.parse(raw);
    if (input.stream === true) return proxy(req, res, { body: raw });
    const enhanced = enhanceMessages(input.messages || []);
    return proxy(req, res, { body: JSON.stringify({ ...input, messages: enhanced.messages }) });
  } catch (error) {
    return sendJson(res, 400, { error: { message: error.message || "Payload tidak valid.", code: "invalid_request" } });
  }
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (req.method === "POST" && pathname === "/v1/messages") return void handleAnthropic(req, res);
  if (req.method === "POST" && ["/v1/nextura/chat", "/v1/nextura/messages"].includes(pathname)) return void handleNextura(req, res);
  if (req.method === "POST" && pathname === "/v1/chat/completions") return void handleOpenAI(req, res);
  return proxy(req, res);
});

server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 75000);
server.headersTimeout = server.keepAliveTimeout + 5000;

function shutdown(signal) {
  console.log(`[sdk-compat] Shutdown ${signal}`);
  server.close(() => { if (!child.killed) child.kill("SIGTERM"); });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, HOST, () => {
  console.log(`[sdk-compat] Public Nextura SDK gateway online di http://${HOST}:${PORT}`);
  console.log(`[sdk-compat] Core terminal-agent di http://127.0.0.1:${CORE_PORT}`);
  console.log("[sdk-compat] OpenAI /v1/chat/completions · Anthropic /v1/messages · Nextura /v1/nextura/chat");
});