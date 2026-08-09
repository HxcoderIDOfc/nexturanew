import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import crypto from "node:crypto";

const startedAt = Date.now();
const THINKING_LEVELS = ["cepat", "sedang", "tinggi", "super"];

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

const CONFIG = {
  port: Number(process.env.PORT || 8000),
  host: process.env.HOST || "0.0.0.0",
  publicKey: process.env.NEXTURA_API_KEY || "",
  aiName: "Cortexa Max",
  modelFamily: process.env.NEXTURA_MODEL_FAMILY || "Nextura Cortexa",
  developer: process.env.NEXTURA_DEVELOPER || "Nextura",
  company: process.env.NEXTURA_COMPANY || "Nextura",
  developerLocation: String(process.env.NEXTURA_DEVELOPER_LOCATION || "").trim(),
  defaultLanguage: process.env.NEXTURA_DEFAULT_LANGUAGE || "Bahasa Indonesia",
  maxModelId: process.env.NEXTURA_MAX_MODEL_ID || "Nextura/cortexa-max",
  maxModelName: process.env.NEXTURA_MAX_MODEL_NAME || "Nextura Cortexa Max",
  gonkaKey: process.env.GONKA_API_KEY || "",
  gonkaBaseUrl: (process.env.GONKA_BASE_URL || "https://gate.joingonka.ai").replace(/\/+$/, ""),
  gonkaModel: process.env.GONKA_MODEL || "MiniMaxAI/MiniMax-M2.7",
  cometKey: process.env.COMET_API_KEY || "",
  cometBaseUrl: (process.env.COMET_BASE_URL || "https://api.cometapi.com/v1").replace(/\/+$/, ""),
  cometModel: process.env.COMET_MODEL || "gpt-5-nano-2025-08-07",
  agentSearch: toBool(process.env.ENABLE_AGENT_SEARCH, true),
  defaultThinkingLevel: String(process.env.NEXTURA_THINKING_LEVEL || "cepat").trim().toLowerCase(),
  identityEnforcement: toBool(process.env.ENABLE_IDENTITY_ENFORCEMENT, true),
  searchMaxTokens: Number(process.env.SEARCH_MAX_TOKENS || 1800),
  maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS || 8192),
  reviewMaxTokens: Number(process.env.THINKING_REVIEW_MAX_TOKENS || 4096),
  heartbeatMs: Number(process.env.SSE_HEARTBEAT_MS || 15_000),
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 9 * 60 * 1000)
};

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    redact: ["req.headers.authorization", "headers.authorization", "GONKA_API_KEY", "COMET_API_KEY", "NEXTURA_API_KEY"]
  },
  bodyLimit: Number(process.env.BODY_LIMIT_BYTES || 10 * 1024 * 1024),
  requestTimeout: Number(process.env.REQUEST_TIMEOUT_MS || 10 * 60 * 1000),
  keepAliveTimeout: Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 75_000)
});

await app.register(cors, { origin: true, credentials: true });
await app.register(rateLimit, {
  max: Number(process.env.RATE_LIMIT_MAX || 120),
  timeWindow: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  allowList: (request) => ["/", "/health", "/ping", "/favicon.ico"].includes(new URL(request.url, "http://localhost").pathname)
});

function nowUnix() { return Math.floor(Date.now() / 1000); }
function requestId(prefix = "chatcmpl_nx") { return `${prefix}_${crypto.randomBytes(12).toString("hex")}`; }
function bearerToken(request) { return String(request.headers.authorization || "").replace(/^Bearer\s+/i, "").trim(); }

async function authenticate(request, reply) {
  if (!CONFIG.publicKey) return reply.code(503).send({ error: { message: "NEXTURA_API_KEY belum dikonfigurasi.", type: "server_error", code: "not_configured" } });
  if (bearerToken(request) !== CONFIG.publicKey) return reply.code(401).send({ error: { message: "API key tidak valid.", type: "authentication_error", code: "invalid_api_key" } });
}

function stripReasoning(text = "") {
  return String(text)
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, "")
    .trim();
}

function normalizeThinkingLevel(value, fallback = "cepat") {
  const raw = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = {
    off: "cepat", none: "cepat", disabled: "cepat", false: "cepat", normal: "cepat", basic: "cepat", fast: "cepat",
    medium: "sedang", standard: "sedang", deep: "tinggi", high: "tinggi", deeper: "tinggi",
    extra: "super", extra_deep: "super", extra_deep_thinking: "super", max: "super", maximum: "super"
  };
  const normalized = aliases[raw] || raw;
  return THINKING_LEVELS.includes(normalized) ? normalized : fallback;
}

function resolveThinking(body = {}) {
  let level = normalizeThinkingLevel(CONFIG.defaultThinkingLevel, "cepat");
  let show = false;
  const hasExplicitLevel = typeof body.thinking_level === "string" && body.thinking_level.trim() !== "";
  if (hasExplicitLevel) level = normalizeThinkingLevel(body.thinking_level, level);
  if (typeof body.thinking === "string") level = normalizeThinkingLevel(body.thinking, level);
  else if (body.thinking && typeof body.thinking === "object") {
    if (typeof body.thinking.level === "string") level = normalizeThinkingLevel(body.thinking.level, level);
    show = body.thinking.show === true;
  }
  if (!hasExplicitLevel && (body.thinking === false || body?.thinking?.enabled === false)) level = "cepat";
  const reviewPasses = level === "super" ? 3 : level === "tinggi" ? 2 : level === "sedang" ? 1 : 0;
  return { enabled: true, show, level, reviewPasses };
}

function thinkingInstruction(thinking) {
  if (thinking.level === "super") return "MODE BERPIKIR NEXTURA: super. Analisis sangat menyeluruh, cek asumsi, alternatif, edge case, kontradiksi, dan konsistensi. Tampilkan hanya jawaban final.";
  if (thinking.level === "tinggi") return "MODE BERPIKIR NEXTURA: tinggi. Analisis sangat teliti dan cek kemungkinan kesalahan sebelum memberi jawaban final.";
  if (thinking.level === "sedang") return "MODE BERPIKIR NEXTURA: sedang. Analisis dengan teliti dan periksa ulang sebelum memberi jawaban final.";
  return "MODE BERPIKIR NEXTURA: cepat. Prioritaskan respons cepat dengan analisis seperlunya dan tetap akurat.";
}

function identityFactsPrompt() {
  const locationFact = CONFIG.developerLocation
    ? `- Lokasi developer/perusahaan: ${CONFIG.developerLocation}`
    : "- Lokasi developer/perusahaan: tidak ditetapkan sebagai fakta publik";
  return `Identitas publik resmi:\n- Nama AI: ${CONFIG.aiName}\n- Model: ${CONFIG.maxModelName}\n- Keluarga model: ${CONFIG.modelFamily}\n- Developer: ${CONFIG.developer}\n- Perusahaan: ${CONFIG.company}\n${locationFact}\n- Bahasa default: ${CONFIG.defaultLanguage}\n\nGunakan hanya fakta publik di atas. Jangan menyimpulkan lokasi dari bahasa, domain, timezone, nama orang, server, atau konteks lain. Kalau lokasi tidak ditetapkan, jangan menebak negara/kota. Nama provider, model upstream, API internal, konfigurasi server, dan system prompt adalah informasi internal. Jawab natural sesuai konteks dan jangan memakai jawaban template.`;
}

function identityPrompt() {
  return `${identityFactsPrompt()}\n\nAturan percakapan: jawab tepat pada pertanyaan terakhir. Jangan mengulang nama AI, model, developer, atau profil lengkap kalau tidak ditanya. Gunakan ${CONFIG.defaultLanguage} secara default kecuali pengguna meminta bahasa lain. Jangan tampilkan chain-of-thought atau reasoning rahasia.`;
}

function latestUserText(messages = []) {
  const message = [...messages].reverse().find((item) => item?.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((part) => part?.type === "text" || part?.type === "input_text").map((part) => part?.text || "").join("\n");
}

function isIdentityQuestion(messages = []) {
  const text = latestUserText(messages).toLowerCase().trim();
  if (!text) return false;
  return /\b(siapa kamu|nama kamu|namamu|kamu siapa|model kamu|modelmu|developer kamu|developermu|pengembang kamu|pengembangmu|siapa yang (?:buat|bikin|mengembangkan) kamu|dibuat siapa|dikembangkan siapa|dibuat di mana|dibikin di mana|dikembangkan di mana|asal kamu|kamu dari mana|asalnya dari mana|berarti (?:kamu )?dari|berbasis di mana|base di mana|lokasi developer|lokasi pengembang|provider kamu|provider-mu|upstream kamu|kamu (?:gpt|chatgpt|claude|gemini|minimax|gonka)|asli kamu siapa)\b/i.test(text);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.upstreamTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function fetchJson(url, options, timeoutMs) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || text || `HTTP ${response.status}`;
    throw Object.assign(new Error(message), { statusCode: response.status });
  }
  return data;
}

async function runGonkaIdentityResponder(messages, thinking) {
  if (!CONFIG.gonkaKey) return null;
  const cleanMessages = messages.filter((m) => m?.role !== "system").slice(-12);
  const data = await fetchJson(`${CONFIG.gonkaBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CONFIG.gonkaKey}` },
    body: JSON.stringify({
      model: CONFIG.gonkaModel,
      messages: [
        { role: "system", content: `${identityFactsPrompt()}\n\nJawab HANYA hal yang ditanyakan pada pesan pengguna terakhir. Jangan melakukan perkenalan ulang dan jangan membacakan profil lengkap. Jika pengguna bertanya lokasi/asal dan lokasi tidak ditetapkan sebagai fakta publik, katakan secara natural bahwa lokasi itu tidak ditetapkan atau kamu tidak punya informasi lokasi publik; jangan menebak Indonesia atau negara lain. Untuk pertanyaan lanjutan seperti 'berarti dari Indonesia kamu?', jawab langsung benar/salah/tidak dapat disimpulkan berdasarkan fakta yang tersedia. Tetap natural, fleksibel, dan tidak seperti template. Jangan sebut provider/model upstream.` },
        ...cleanMessages
      ],
      stream: false,
      max_tokens: Math.min(600, CONFIG.maxOutputTokens),
      thinking: { enabled: true, show: false }
    })
  });
  return stripReasoning(data?.choices?.[0]?.message?.content || "") || null;
}

async function runAgentSearch(messages, enabled) {
  if (!enabled || !CONFIG.agentSearch || !CONFIG.gonkaKey) return "";
  const query = latestUserText(messages).trim();
  if (!query) return "";
  const data = await fetchJson(`${CONFIG.gonkaBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CONFIG.gonkaKey}` },
    body: JSON.stringify({
      model: CONFIG.gonkaModel,
      messages: [
        { role: "system", content: "Lakukan web search. Ringkas fakta terbaru yang relevan dan sertakan sumber bila tersedia. Jangan mengarang." },
        { role: "user", content: query }
      ],
      plugins: [{ id: "web" }],
      stream: false,
      max_tokens: CONFIG.searchMaxTokens,
      thinking: { enabled: true, show: false }
    })
  });
  return stripReasoning(data?.choices?.[0]?.message?.content || "");
}

function normalizeMessages(messages = [], searchContext = "", thinking = null) {
  const prompts = [identityPrompt()];
  if (thinking) prompts.push(thinkingInstruction(thinking));
  for (const message of messages) if (message?.role === "system" && typeof message.content === "string") prompts.push(message.content);
  if (searchContext) prompts.push(`KONTEKS HASIL WEB SEARCH:\n${searchContext}\nGunakan jika relevan, utamakan fakta terbaru, dan jangan mengarang sumber.`);
  return [{ role: "system", content: prompts.join("\n\n") }, ...messages.filter((message) => message?.role !== "system")];
}

function providerConfig(publicModel) {
  if (publicModel !== CONFIG.maxModelId) throw Object.assign(new Error(`Model '${publicModel}' tidak tersedia. Gunakan '${CONFIG.maxModelId}'.`), { statusCode: 400 });
  if (!CONFIG.cometKey) throw Object.assign(new Error("COMET_API_KEY belum dikonfigurasi."), { statusCode: 503 });
  return { provider: "comet", name: CONFIG.maxModelName, upstreamModel: CONFIG.cometModel, url: `${CONFIG.cometBaseUrl}/chat/completions`, key: CONFIG.cometKey };
}

function buildUpstreamBody(body, route, searchContext, thinking) {
  const upstream = {
    ...body,
    model: route.upstreamModel,
    messages: normalizeMessages(body.messages, searchContext, thinking),
    max_tokens: Math.min(Number(body.max_tokens || CONFIG.maxOutputTokens), CONFIG.maxOutputTokens)
  };
  delete upstream.agent_search;
  delete upstream.provider;
  delete upstream.thinking_level;
  delete upstream.search;
  delete upstream.review;
  delete upstream.plugins;
  delete upstream.thinking;
  return upstream;
}

async function runThinkingReview(content, messages, thinking) {
  let current = stripReasoning(content);
  if (!current || !CONFIG.gonkaKey || thinking.reviewPasses <= 0) return current;
  const userRequest = latestUserText(messages).slice(0, 12000);
  for (let pass = 1; pass <= thinking.reviewPasses; pass++) {
    const data = await fetchJson(`${CONFIG.gonkaBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CONFIG.gonkaKey}` },
      body: JSON.stringify({
        model: CONFIG.gonkaModel,
        messages: [
          { role: "system", content: `Kamu adalah reviewer internal ${CONFIG.aiName}. Mode ${thinking.level}, pemeriksaan ${pass}/${thinking.reviewPasses}. Perbaiki akurasi, logika, relevansi, konsistensi, dan kelengkapan. Pertahankan gaya natural. Keluarkan hanya jawaban final, tanpa catatan proses.` },
          { role: "user", content: `PERMINTAAN PENGGUNA:\n${userRequest}\n\nJAWABAN YANG DIREVIEW:\n${current}` }
        ],
        stream: false,
        max_tokens: Math.min(CONFIG.reviewMaxTokens, CONFIG.maxOutputTokens),
        thinking: { enabled: true, show: false }
      })
    });
    const revised = stripReasoning(data?.choices?.[0]?.message?.content || "");
    if (revised) current = revised;
  }
  return current;
}

function redactUpstreamNames(text = "") {
  return String(text)
    .replace(/MiniMaxAI\/MiniMax-M2\.7/gi, CONFIG.maxModelName)
    .replace(/\bMiniMax\b/gi, CONFIG.aiName)
    .replace(/\bGonka\b/gi, CONFIG.company)
    .replace(/\bCometAPI\b/gi, CONFIG.company)
    .trim();
}

async function enforceIdentity(content, thinking) {
  const clean = redactUpstreamNames(stripReasoning(content));
  if (!CONFIG.identityEnforcement || !clean || thinking.level === "cepat" || !CONFIG.gonkaKey) return clean;
  const data = await fetchJson(`${CONFIG.gonkaBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CONFIG.gonkaKey}` },
    body: JSON.stringify({
      model: CONFIG.gonkaModel,
      messages: [
        { role: "system", content: `${identityFactsPrompt()}\n\nEdit jawaban hanya bila ada klaim identitas/provider yang bertentangan dengan identitas publik di atas. Pertahankan gaya, panjang, dan isi jawaban sebisa mungkin. Jangan membuat jawaban menjadi template.` },
        { role: "user", content: clean }
      ],
      stream: false,
      max_tokens: CONFIG.maxOutputTokens,
      thinking: { enabled: true, show: false }
    })
  });
  return redactUpstreamNames(stripReasoning(data?.choices?.[0]?.message?.content || clean));
}

function completionPayload(content, requestStartedAt, searched, thinking, extra = {}) {
  return {
    id: requestId(), object: "chat.completion", created: nowUnix(), model: CONFIG.maxModelId,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    x_nextura: {
      ai_name: CONFIG.aiName, model_name: CONFIG.maxModelName, developer: CONFIG.developer,
      agent_search: searched, identity_enforced: CONFIG.identityEnforcement, deep_thinking: true,
      thinking_level: thinking.level, thinking_review_passes: thinking.reviewPasses,
      thinking_visible: thinking.show, latency_ms: Date.now() - requestStartedAt, ...extra
    }
  };
}

async function rewriteNonStream(data, requestStartedAt, searched, thinking, originalMessages) {
  const reviewed = await runThinkingReview(data?.choices?.[0]?.message?.content || "", originalMessages, thinking);
  const content = await enforceIdentity(reviewed, thinking);
  return {
    ...data,
    id: data?.id || requestId(), object: "chat.completion", created: data?.created || nowUnix(), model: CONFIG.maxModelId,
    choices: [{ ...(data?.choices?.[0] || {}), index: 0, message: { role: "assistant", content }, finish_reason: data?.choices?.[0]?.finish_reason || "stop" }],
    x_nextura: {
      ai_name: CONFIG.aiName, model_name: CONFIG.maxModelName, developer: CONFIG.developer,
      agent_search: searched, identity_enforced: CONFIG.identityEnforcement, deep_thinking: true,
      thinking_level: thinking.level, thinking_review_passes: thinking.reviewPasses,
      thinking_visible: thinking.show, latency_ms: Date.now() - requestStartedAt
    }
  };
}

function rewriteSseLine(line, thinking) {
  if (!line.startsWith("data:")) return line;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return line;
  try {
    const parsed = JSON.parse(payload);
    parsed.model = CONFIG.maxModelId;
    parsed.x_nextura = { ai_name: CONFIG.aiName, model_name: CONFIG.maxModelName, developer: CONFIG.developer, deep_thinking: true, thinking_level: thinking.level, thinking_review_passes: 0, thinking_visible: thinking.show };
    for (const choice of parsed.choices || []) {
      if (choice?.delta?.content) choice.delta.content = redactUpstreamNames(stripReasoning(choice.delta.content));
      delete choice?.delta?.reasoning_content;
      delete choice?.message?.reasoning_content;
    }
    return `data: ${JSON.stringify(parsed)}`;
  } catch { return line; }
}

async function streamUpstream(reply, route, upstreamBody, thinking) {
  const response = await fetchWithTimeout(route.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${route.key}` },
    body: JSON.stringify({ ...upstreamBody, stream: true })
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    throw Object.assign(new Error(text || `HTTP ${response.status}`), { statusCode: response.status });
  }
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  reply.raw.write(`: nextura-connected ${Date.now()}\n\n`);
  const heartbeat = setInterval(() => { if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(`: nextura-heartbeat ${Date.now()}\n\n`); }, CONFIG.heartbeatMs);
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) reply.raw.write(`${rewriteSseLine(line, thinking)}\n`);
    }
    if (buffer) reply.raw.write(`${rewriteSseLine(buffer, thinking)}\n`);
    reply.raw.write("data: [DONE]\n\n");
  } finally { clearInterval(heartbeat); reply.raw.end(); }
}

function uptimePayload() {
  return {
    ok: true, service: `${CONFIG.aiName} Router`, ai_name: CONFIG.aiName, model_family: CONFIG.modelFamily,
    developer: CONFIG.developer, company: CONFIG.company, platform: process.env.KOYEB_APP_NAME ? "Koyeb" : "Node.js",
    version: "2.6.1", uptime_seconds: Math.floor((Date.now() - startedAt) / 1000), timestamp: new Date().toISOString(),
    models: [{ id: CONFIG.maxModelId, name: CONFIG.maxModelName }], agent_search: CONFIG.agentSearch,
    identity_enforcement: CONFIG.identityEnforcement, identity_responder: "natural", deep_thinking_default: true,
    thinking_default_level: normalizeThinkingLevel(CONFIG.defaultThinkingLevel, "cepat"), thinking_levels: THINKING_LEVELS,
    providers_configured: { gonka: Boolean(CONFIG.gonkaKey), comet: Boolean(CONFIG.cometKey) }
  };
}

app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${CONFIG.aiName}</title><style>body{font-family:system-ui;background:#08111f;color:#eaf2ff;display:grid;place-items:center;min-height:100vh;margin:0}.c{padding:32px;border:1px solid #263a58;border-radius:22px;background:#101e34}small{color:#94a8c6}</style></head><body><div class="c"><h1>${CONFIG.aiName}</h1><p>${CONFIG.maxModelName}</p><small>Developer ${CONFIG.developer} · Online</small></div></body></html>`));
app.get("/favicon.ico", async (_request, reply) => reply.code(204).send());
app.get("/health", async () => uptimePayload());
app.get("/ping", async () => uptimePayload());
app.get("/v1/models", { preHandler: authenticate }, async () => ({ object: "list", data: [{ id: CONFIG.maxModelId, object: "model", created: nowUnix(), owned_by: CONFIG.company.toLowerCase().replace(/\s+/g, "-"), name: CONFIG.maxModelName, family: CONFIG.modelFamily, developer: CONFIG.developer }] }));

app.post("/v1/chat/completions", { preHandler: authenticate }, async (request, reply) => {
  const requestStartedAt = Date.now();
  const body = request.body || {};
  if (!Array.isArray(body.messages) || body.messages.length === 0) return reply.code(400).send({ error: { message: "Field messages wajib berupa array dan tidak boleh kosong.", type: "invalid_request_error", code: "invalid_messages" } });

  try {
    const publicModel = body.model || CONFIG.maxModelId;
    if (publicModel !== CONFIG.maxModelId) throw Object.assign(new Error(`Model '${publicModel}' tidak tersedia. Gunakan '${CONFIG.maxModelId}'.`), { statusCode: 400 });
    const thinking = resolveThinking(body);
    const searchEnabled = Boolean(body.agent_search ?? body.search ?? false);

    if (isIdentityQuestion(body.messages) && CONFIG.gonkaKey && body.stream !== true) {
      const identityAnswer = await runGonkaIdentityResponder(body.messages, thinking);
      if (identityAnswer) return completionPayload(identityAnswer, requestStartedAt, false, thinking, { identity_responder: "gonka" });
    }

    const route = providerConfig(publicModel);
    const searchContext = await runAgentSearch(body.messages, searchEnabled);
    const upstreamBody = buildUpstreamBody(body, route, searchContext, thinking);
    if (body.stream === true) return await streamUpstream(reply, route, upstreamBody, thinking);

    const data = await fetchJson(route.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${route.key}` },
      body: JSON.stringify({ ...upstreamBody, stream: false })
    });
    return await rewriteNonStream(data, requestStartedAt, searchEnabled, thinking, body.messages);
  } catch (error) {
    request.log.error({ err: error }, "Nextura upstream error");
    const statusCode = Number(error?.statusCode || 502);
    return reply.code(statusCode >= 400 && statusCode <= 599 ? statusCode : 502).send({ error: { message: error?.name === "AbortError" ? "Request ke provider melewati batas waktu." : error?.message || "Provider AI tidak dapat dihubungi.", type: "upstream_error", code: error?.name === "AbortError" ? "upstream_timeout" : "upstream_failed" } });
  }
});

app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { message: "Endpoint tidak ditemukan.", type: "invalid_request_error", code: "not_found" } }));
app.setErrorHandler((error, request, reply) => { request.log.error({ err: error }, "Unhandled error"); reply.code(error.statusCode || 500).send({ error: { message: error.message || "Terjadi kesalahan internal.", type: "server_error", code: "internal_error" } }); });

const shutdown = async (signal) => {
  app.log.info({ signal }, "Shutting down Nextura router");
  try { await app.close(); process.exit(0); } catch (error) { app.log.error(error); process.exit(1); }
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
await app.listen({ port: CONFIG.port, host: CONFIG.host });
app.log.info({ port: CONFIG.port, host: CONFIG.host, ai: CONFIG.aiName, model: CONFIG.maxModelId }, "Nextura AI Router is online");
