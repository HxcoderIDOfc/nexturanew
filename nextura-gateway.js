import http from "node:http";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { spawn } from "node:child_process";

const PUBLIC_PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";
const INTERNAL_PORT = Number(process.env.GATEWAY_INTERNAL_PORT || (PUBLIC_PORT === 8000 ? 8002 : PUBLIC_PORT + 2));
const ROUTER_PORT = Number(process.env.ROUTER_INTERNAL_PORT || INTERNAL_PORT + 1);
const TOOL_PORT = Number(process.env.TOOL_INTERNAL_PORT || ROUTER_PORT + 1);
const MAX_PROXY_BODY = Number(process.env.BODY_LIMIT_BYTES || 10 * 1024 * 1024);
const HTTP_TOOL_TIMEOUT = Number(process.env.HTTP_TOOL_TIMEOUT_MS || 30_000);
const HTTP_TOOL_MAX_BYTES = Number(process.env.HTTP_TOOL_MAX_BYTES || 30_000);
const WEB_READER_MAX_PAGES = Math.max(1, Math.min(Number(process.env.WEB_READER_MAX_PAGES || 4), 6));
const WEB_READER_MAX_CHARS = Math.max(8000, Math.min(Number(process.env.WEB_READER_MAX_CHARS || 50000), 120000));

const AI_NAME = "Cortexa Max";
const MODEL_FAMILY = process.env.NEXTURA_MODEL_FAMILY || "Nextura Cortexa";
const DEVELOPER = process.env.NEXTURA_DEVELOPER || "Nextura";
const COMPANY = process.env.NEXTURA_COMPANY || "Nextura";
const MAX_MODEL_ID = process.env.NEXTURA_MAX_MODEL_ID || "Nextura/cortexa-max";
const MAX_MODEL_NAME = process.env.NEXTURA_MAX_MODEL_NAME || "Nextura Cortexa Max";

const routerChild = spawn(process.execPath, ["koyeb.js"], {
  env: { ...process.env, PORT: String(INTERNAL_PORT), INTERNAL_PORT: String(ROUTER_PORT), HOST: "127.0.0.1" },
  stdio: "inherit"
});

const toolChild = spawn(process.execPath, ["terminal-tool.js"], {
  env: { ...process.env, TOOL_INTERNAL_PORT: String(TOOL_PORT) },
  stdio: "inherit"
});

for (const [name, child] of [["router", routerChild], ["tool", toolChild]]) {
  child.on("exit", (code, signal) => {
    console.error(`[nextura-json] ${name} berhenti. code=${code} signal=${signal}`);
    process.exit(code ?? 1);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function nexturaId() { return `nextura_${crypto.randomBytes(12).toString("hex")}`; }

function normalizeUsage(usage = {}) {
  const promptTokens = Number(usage.prompt_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: Number(usage.total_tokens || promptTokens + completionTokens)
  };
}

function toNexturaJson(data = {}) {
  const choice = data?.choices?.[0] || {};
  const sourceMeta = data.nextura || data.x_nextura || {};
  return {
    id: String(data.id || nexturaId()).replace(/^devshard-/i, "nextura-"),
    object: "chat.completion",
    created: Number(data.created || Math.floor(Date.now() / 1000)),
    model: MAX_MODEL_ID,
    choices: [{
      index: 0,
      message: { role: "assistant", content: choice?.message?.content || "" },
      finish_reason: choice.finish_reason || "stop"
    }],
    usage: normalizeUsage(data.usage),
    nextura: {
      schema: "nextura.chat.v1",
      ai_name: sourceMeta.ai_name || AI_NAME,
      model_id: MAX_MODEL_ID,
      model_name: sourceMeta.model_name || MAX_MODEL_NAME,
      model_family: MODEL_FAMILY,
      developer: sourceMeta.developer || DEVELOPER,
      company: COMPANY,
      agent_search: Boolean(sourceMeta.agent_search),
      search_plugin: sourceMeta.search_plugin || null,
      identity_enforced: sourceMeta.identity_enforced !== false,
      deep_thinking: true,
      thinking_level: sourceMeta.thinking_level || "cepat",
      thinking_review_passes: Number(sourceMeta.thinking_review_passes || 0),
      thinking_visible: Boolean(sourceMeta.thinking_visible),
      tool_used: sourceMeta.tool_used || null,
      vision_url: Boolean(sourceMeta.vision_url),
      latency_ms: Number(sourceMeta.latency_ms || 0)
    }
  };
}

function tokenFromHeaders(headers = {}) {
  return String(headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
}

function latestUserMessage(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return { message: messages[i], index: i };
  }
  return { message: null, index: -1 };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((x) => x?.type === "text" || x?.type === "input_text")
    .map((x) => x.text || "")
    .join("\n");
}

function extractUrls(text = "") {
  return [...String(text).matchAll(/https?:\/\/[^\s<>"')\]]+/gi)]
    .map((m) => m[0].replace(/[.,;:!?]+$/, ""));
}

function extractBareDomains(text = "") {
  const cleaned = String(text).replace(/https?:\/\/[^\s<>"')\]]+/gi, " ");
  const matches = [...cleaned.matchAll(/\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[a-z0-9._~:/?#\[\]@!$&'()*+,;=%-]*)?/gi)];
  return matches.map((m) => m[0].replace(/[.,;:!?]+$/, ""));
}

function webTargetFromText(text = "") {
  const full = extractUrls(text)[0];
  if (full) return full;
  const bare = extractBareDomains(text)[0];
  if (!bare) return null;
  return `https://${bare}`;
}

function looksLikeImageUrl(value = "") {
  try {
    const url = new URL(value);
    return /\.(?:png|jpe?g|webp|gif|bmp|avif)(?:$|\?)/i.test(url.pathname + url.search);
  } catch {
    return false;
  }
}

function attachVisionUrl(body) {
  const messages = Array.isArray(body.messages) ? structuredClone(body.messages) : [];
  const { message, index } = latestUserMessage(messages);
  if (!message) return { body: { ...body, model: MAX_MODEL_ID, messages }, attached: false };

  if (Array.isArray(message.content) && message.content.some((p) => ["image_url", "input_image", "image"].includes(p?.type))) {
    return { body: { ...body, model: MAX_MODEL_ID, messages }, attached: true };
  }

  const text = contentText(message.content);
  const asksVision = /\b(foto|gambar|image|vision|lihat|analisis|jelaskan isi|baca gambar)\b/i.test(text);
  const imageUrl = extractUrls(text).find(looksLikeImageUrl);
  if (!asksVision || !imageUrl) return { body: { ...body, model: MAX_MODEL_ID, messages }, attached: false };

  message.content = [
    { type: "text", text },
    { type: "image_url", image_url: { url: imageUrl, detail: "auto" } }
  ];
  messages[index] = message;
  return { body: { ...body, model: MAX_MODEL_ID, messages }, attached: true };
}

function jakartaNow() {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short"
  }).format(new Date());
}

function applySearchAwareness(body) {
  const searchRequested = Boolean(body.agent_search ?? body.search ?? false);
  if (!searchRequested) return { body, plugin: null };

  const messages = Array.isArray(body.messages) ? structuredClone(body.messages) : [];
  messages.unshift({
    role: "system",
    content: `WAKTU SERVER NEXTURA: ${jakartaNow()} (Asia/Jakarta). Web search aktif untuk request ini. Gunakan konteks hasil pencarian terbaru yang diberikan sistem dan jangan mengatakan bahwa kamu tidak punya akses internet atau tidak tahu tanggal hari ini.`
  });

  return {
    body: { ...body, model: MAX_MODEL_ID, messages },
    plugin: "gonka_web"
  };
}

function isPrivateIp(ip) {
  if (!net.isIP(ip)) return true;
  if (["127.0.0.1", "0.0.0.0", "::1"].includes(ip)) return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("169.254.")) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return /^(fc|fd|fe80)/i.test(ip);
}

async function validatePublicHttpUrl(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Tool HTTP hanya menerima URL http/https.");
  const records = await dns.lookup(url.hostname, { all: true });
  if (!records.length || records.some((r) => isPrivateIp(r.address))) throw new Error("Alamat lokal/internal ditolak.");
  return url;
}

function wantsHttpTool(text = "") {
  return /\b(curl|request http|akses url|buka endpoint|tes endpoint|test endpoint|cek endpoint|panggil api|hit api)\b/i.test(text);
}

function wantsWebReader(text = "") {
  return /\b(cek|check|buka|open|baca|read|lihat|kunjungi|visit|akses|access|pelajari|ringkas|rangkum|analisis|dokumentasi|documentation|docs|website|web|situs|site|halaman|page|api reference|getting started|guide|panduan)\b/i.test(text);
}

function wantsDeepWebRead(text = "") {
  return /\b(semua|seluruh|lengkap|secara lengkap|detail lengkap|telusuri|jelajahi|crawl|semua halaman|seluruh halaman|semua dokumentasi|seluruh dokumentasi|endpoint lengkap|semua endpoint|cari endpoint|api lengkap|dokumentasi lengkap|baca semua|baca seluruh|pelajari semua|pelajari seluruh|bandingkan (?:bagian|halaman)|multi[- ]?page)\b/i.test(String(text));
}

async function runHttpTool(urlValue, incomingHeaders, options = {}) {
  const url = await validatePublicHttpUrl(urlValue);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TOOL_TIMEOUT);
  const started = Date.now();

  try {
    const headers = {
      "user-agent": options.userAgent || "Nextura-Web-Reader/1.0",
      accept: options.accept || "application/json,text/plain,text/html;q=0.9,*/*;q=0.5"
    };
    if (options.forwardAuthorization === true) {
      const incomingToken = tokenFromHeaders(incomingHeaders);
      if (incomingToken) headers.authorization = `Bearer ${incomingToken}`;
    }

    const response = await fetch(url, { method: "GET", headers, redirect: "follow", signal: controller.signal });
    const reader = response.body?.getReader();
    let total = 0;
    const chunks = [];

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        chunks.push(value);
        if (total >= HTTP_TOOL_MAX_BYTES) {
          await reader.cancel();
          break;
        }
      }
    }

    const raw = Buffer.concat(chunks.map((x) => Buffer.from(x))).toString("utf8").slice(0, HTTP_TOOL_MAX_BYTES);
    return {
      ok: response.ok,
      status: response.status,
      final_url: response.url,
      content_type: response.headers.get("content-type") || "",
      latency_ms: Date.now() - started,
      body: raw
    };
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtmlEntities(text = "") {
  return String(text)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function htmlToReadableText(html = "") {
  return decodeHtmlEntities(String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function extractSameOriginLinks(baseValue, html = "") {
  let base;
  try { base = new URL(baseValue); } catch { return []; }
  const out = [];
  const seen = new Set();
  const priority = /(?:docs?|documentation|api|reference|guide|getting[-_ ]?started|quickstart|tutorial|developer|usage|auth|endpoint|sdk)/i;

  for (const match of String(html).matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>/gi)) {
    try {
      const url = new URL(match[1], base);
      if (url.origin !== base.origin) continue;
      if (!["http:", "https:"].includes(url.protocol)) continue;
      url.hash = "";
      const href = url.toString();
      if (seen.has(href) || href === base.toString()) continue;
      seen.add(href);
      out.push({ url: href, score: priority.test(url.pathname + url.search) ? 1 : 0 });
    } catch {}
  }

  return out.sort((a, b) => b.score - a.score).map((x) => x.url);
}

async function runWebReader(target, incomingHeaders, options = {}) {
  const maxPages = Math.max(1, Math.min(Number(options.maxPages || 1), WEB_READER_MAX_PAGES));
  const first = await runHttpTool(target, incomingHeaders, { forwardAuthorization: false, userAgent: "Nextura-Web-Reader/1.0" });
  const pages = [];
  const firstHtml = /text\/html|application\/xhtml\+xml/i.test(first.content_type);
  pages.push({
    url: first.final_url,
    status: first.status,
    content_type: first.content_type,
    text: firstHtml ? htmlToReadableText(first.body) : first.body
  });

  if (first.ok && firstHtml && maxPages > 1) {
    const links = extractSameOriginLinks(first.final_url, first.body).slice(0, maxPages - 1);
    for (const link of links) {
      try {
        const page = await runHttpTool(link, incomingHeaders, { forwardAuthorization: false, userAgent: "Nextura-Web-Reader/1.0" });
        const isHtml = /text\/html|application\/xhtml\+xml/i.test(page.content_type);
        pages.push({
          url: page.final_url,
          status: page.status,
          content_type: page.content_type,
          text: isHtml ? htmlToReadableText(page.body) : page.body
        });
      } catch (error) {
        pages.push({ url: link, status: 0, content_type: "", text: `Gagal dibaca: ${error.message}` });
      }
    }
  }

  let used = 0;
  const compactPages = pages.map((page) => {
    const remaining = Math.max(0, WEB_READER_MAX_CHARS - used);
    const text = String(page.text || "").slice(0, remaining);
    used += text.length;
    return { ...page, text };
  }).filter((page) => page.text || page.status);

  return {
    target,
    mode: maxPages > 1 ? "deep" : "single_page",
    pages_read: compactPages.length,
    pages: compactPages
  };
}

async function prepareChatBody(body, headers) {
  const vision = attachVisionUrl(body);
  const search = applySearchAwareness(vision.body);
  const next = search.body;
  const { message } = latestUserMessage(next.messages || []);
  const text = contentText(message?.content);
  const target = webTargetFromText(text);
  let toolUsed = null;

  if (target && wantsWebReader(text) && !looksLikeImageUrl(target)) {
    try {
      const deepRead = wantsDeepWebRead(text);
      const result = await runWebReader(target, headers, { maxPages: deepRead ? WEB_READER_MAX_PAGES : 1 });
      next.messages = [
        {
          role: "system",
          content: `NEXTURA WEB READER SUDAH MEMBUKA WEBSITE SECARA NYATA. Jangan meminta user memberi tautan lagi dan jangan mengaku belum membuka web. Jawab berdasarkan isi aktual berikut. MODE BACA: ${deepRead ? "mendalam lintas halaman karena user meminta cakupan luas" : "satu halaman saja karena user tidak meminta penelusuran menyeluruh"}. Jika mode satu halaman, jawab hanya inti yang relevan dengan pertanyaan user: apa situs/dokumen ini, untuk apa, dan bagaimana penggunaannya secara garis besar. Jangan merender, menyalin, atau menjabarkan seluruh isi halaman/dokumentasi. Jangan membuat daftar semua bagian kecuali user memintanya. Jika mode mendalam, gabungkan informasi beberapa halaman hanya sejauh yang diminta user. Jangan mengarang hal yang tidak ada di halaman.\n${JSON.stringify(result)}`
        },
        ...(next.messages || [])
      ];
      toolUsed = deepRead ? "web_reader_deep" : "web_reader";
    } catch (error) {
      next.messages = [
        { role: "system", content: `NEXTURA WEB READER sudah mencoba membuka ${target}, tetapi gagal secara nyata: ${error.message}. Jelaskan kegagalan aktual ini; jangan mengatakan bahwa kamu tidak punya kemampuan membuka web.` },
        ...(next.messages || [])
      ];
      toolUsed = "web_reader_failed";
    }
  } else if (target && wantsHttpTool(text) && !looksLikeImageUrl(target)) {
    try {
      const result = await runHttpTool(target, headers, { forwardAuthorization: true, userAgent: "Nextura-HTTP-Tool/1.0" });
      next.messages = [
        { role: "system", content: `HASIL TOOL HTTP NYATA — jangan mengaku tidak punya akses jaringan. Tool sudah menjalankan GET ke URL yang diminta. Jelaskan hasil aktual berikut secara ringkas dan akurat.\n${JSON.stringify(result)}` },
        ...(next.messages || [])
      ];
      toolUsed = "http_get";
    } catch (error) {
      next.messages = [
        { role: "system", content: `TOOL HTTP SUDAH DICOBA tetapi gagal. Jangan mengaku tool tidak tersedia. Jelaskan kegagalan aktual ini: ${error.message}` },
        ...(next.messages || [])
      ];
      toolUsed = "http_get_failed";
    }
  }

  return {
    body: { ...next, model: MAX_MODEL_ID },
    toolUsed,
    visionAttached: vision.attached,
    searchPlugin: search.plugin
  };
}

function proxyRaw(req, res, port) {
  const upstream = http.request({
    hostname: "127.0.0.1",
    port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${port}` }
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", (error) => sendJson(res, 502, { error: { message: "Layanan internal belum siap.", code: "internal_unavailable", detail: error.message } }));
  req.pipe(upstream);
}

function proxyRouter(req, res, preparedBody = null, toolMeta = {}) {
  const headers = { ...req.headers, host: `127.0.0.1:${INTERNAL_PORT}` };
  if (preparedBody) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(preparedBody);
    delete headers["transfer-encoding"];
  }

  const upstream = http.request({
    hostname: "127.0.0.1",
    port: INTERNAL_PORT,
    path: req.url,
    method: req.method,
    headers
  }, (upstreamRes) => {
    const contentType = String(upstreamRes.headers["content-type"] || "");
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    const shouldRewrite = req.method === "POST" && pathname === "/v1/chat/completions" && contentType.includes("application/json") && (upstreamRes.statusCode || 500) >= 200 && (upstreamRes.statusCode || 500) < 300;

    if (!shouldRewrite) {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
      return;
    }

    const chunks = [];
    upstreamRes.on("data", (chunk) => chunks.push(chunk));
    upstreamRes.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        parsed.x_nextura = {
          ...(parsed.x_nextura || {}),
          tool_used: toolMeta.toolUsed || null,
          vision_url: Boolean(toolMeta.visionAttached),
          search_plugin: toolMeta.searchPlugin || null
        };

        const body = JSON.stringify(toNexturaJson(parsed));
        const outHeaders = {
          ...upstreamRes.headers,
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "x-nextura-schema": "nextura.chat.v1"
        };
        delete outHeaders["transfer-encoding"];
        res.writeHead(upstreamRes.statusCode || 200, outHeaders);
        res.end(body);
      } catch {
        sendJson(res, 502, { error: { message: "Gagal membentuk JSON Nextura.", type: "nextura_gateway_error", code: "json_transform_failed" } });
      }
    });
  });

  upstream.on("error", (error) => sendJson(res, 502, {
    error: {
      message: "Nextura router belum siap atau tidak dapat dihubungi.",
      type: "nextura_gateway_error",
      code: "router_unavailable",
      detail: error.message
    }
  }));

  if (preparedBody) upstream.end(preparedBody);
  else req.pipe(upstream);
}

async function handleChat(req, res) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_PROXY_BODY) throw new Error("Payload terlalu besar.");
      chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    const input = raw ? JSON.parse(raw) : {};
    const prepared = await prepareChatBody(input, req.headers);
    proxyRouter(req, res, JSON.stringify(prepared.body), prepared);
  } catch (error) {
    sendJson(res, 400, { error: { message: error.message || "Payload chat tidak valid.", code: "chat_prepare_failed" } });
  }
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname.startsWith("/v1/tools/")) return proxyRaw(req, res, TOOL_PORT);
  if (req.method === "POST" && pathname === "/v1/chat/completions") return void handleChat(req, res);
  return proxyRouter(req, res);
});

server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 75_000);
server.headersTimeout = server.keepAliveTimeout + 5_000;

function shutdown(signal) {
  console.log(`[nextura-json] Shutdown ${signal}`);
  server.close(() => {
    for (const child of [routerChild, toolChild]) if (!child.killed) child.kill("SIGTERM");
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

server.listen(PUBLIC_PORT, HOST, () => {
  console.log(`[nextura-json] Gateway online di http://${HOST}:${PUBLIC_PORT}`);
  console.log(`[nextura-json] Koyeb router internal di http://127.0.0.1:${INTERNAL_PORT}`);
  console.log(`[nextura-json] AI router internal di http://127.0.0.1:${ROUTER_PORT}`);
  console.log(`[nextura-json] Terminal tool internal di http://127.0.0.1:${TOOL_PORT}`);
  console.log(`[nextura-json] Model publik tunggal: ${MAX_MODEL_ID}`);
});
