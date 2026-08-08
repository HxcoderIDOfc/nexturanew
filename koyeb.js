import http from "node:http";
import { spawn } from "node:child_process";
import { classifyMaxTask, maxPolicy, maxBriefPrompt, verifierPrompt } from "./max-engine.js";
import { resolveAutoBooleanFeatures, autoBooleanSystemPrompt } from "./auto-features.js";

const PUBLIC_PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";
const CORE_PORT = Number(process.env.MAX_CORE_PORT || (PUBLIC_PORT === 8000 ? 8005 : PUBLIC_PORT + 5));
const MAX_BODY = Number(process.env.BODY_LIMIT_BYTES || 10 * 1024 * 1024);
const MAX_ENGINE_ENABLED = String(process.env.ENABLE_MAX_ENGINE || "true").toLowerCase() !== "false";

const child = spawn(process.execPath, ["koyeb-base.js"], { env: { ...process.env, PORT: String(CORE_PORT), HOST: "127.0.0.1" }, stdio: "inherit" });
child.on("exit", (code, signal) => { console.error(`[koyeb-max] core berhenti. code=${code} signal=${signal}`); process.exit(code ?? 1); });

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", ...extraHeaders });
  res.end(body);
}

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new Error("Payload terlalu besar"); chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8");
}

function coreRequest(pathname, method, headers, body = null) {
  return new Promise((resolve, reject) => {
    const outHeaders = { ...headers, host: `127.0.0.1:${CORE_PORT}` };
    if (body !== null) { outHeaders["content-type"] = "application/json"; outHeaders["content-length"] = Buffer.byteLength(body); delete outHeaders["transfer-encoding"]; }
    const req = http.request({ hostname: "127.0.0.1", port: CORE_PORT, path: pathname, method, headers: outHeaders }, (resp) => {
      const chunks = []; resp.on("data", (c) => chunks.push(c)); resp.on("end", () => resolve({ status: resp.statusCode || 502, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); if (body !== null) req.end(body); else req.end();
  });
}

function proxy(req, res, body = null, extraHeaders = {}) {
  const headers = { ...req.headers, host: `127.0.0.1:${CORE_PORT}` };
  if (body !== null) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(body); delete headers["transfer-encoding"]; }
  const upstream = http.request({ hostname: "127.0.0.1", port: CORE_PORT, path: req.url, method: req.method, headers }, (upstreamRes) => { res.writeHead(upstreamRes.statusCode || 502, { ...upstreamRes.headers, ...extraHeaders }); upstreamRes.pipe(res); });
  upstream.on("error", (error) => sendJson(res, 502, { error: { message: "Nextura Max core belum siap.", code: "max_core_unavailable", detail: error.message } }));
  if (body !== null) upstream.end(body); else req.pipe(upstream);
}

function latestUserText(messages = []) {
  const m = [...messages].reverse().find((x) => x?.role === "user");
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content.filter((p) => p?.type === "text" || p?.type === "input_text").map((p) => p.text || "").join("\n");
}
function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

async function buildTaskBrief(input, headers, profile) {
  const briefBody = {
    model: input.model || "Nextura/cortexa-max",
    messages: [
      { role: "system", content: "INTERNAL NEXTURA MAX PLANNER. Buat task brief singkat untuk model utama. Jangan menjawab user dan jangan mengungkap chain-of-thought." },
      { role: "user", content: maxBriefPrompt(latestUserText(input.messages || []), profile) }
    ],
    thinking_level: "cepat", search: false, agent_search: false, review: false, thinking: false, stream: false, max_tokens: 700
  };
  const response = await coreRequest("/v1/chat/completions", "POST", headers, JSON.stringify(briefBody));
  if (response.status < 200 || response.status >= 300) return "";
  const data = parseJson(response.body);
  return String(data?.choices?.[0]?.message?.content || "").trim().slice(0, 5000);
}

async function verifyAnswer(input, headers, answer, policy, passes) {
  let current = String(answer || "");
  const userRequest = latestUserText(input.messages || []);
  for (let pass = 0; pass < passes; pass++) {
    const body = {
      model: input.model || "Nextura/cortexa-max",
      messages: [
        { role: "system", content: "INTERNAL NEXTURA MAX VERIFIER. Jangan menjelaskan proses review. Keluarkan hanya jawaban final untuk pengguna." },
        { role: "user", content: verifierPrompt(userRequest, current, policy) }
      ],
      thinking_level: pass === 0 ? "cepat" : "sedang", search: false, agent_search: false, review: false, thinking: true, stream: false, max_tokens: input.max_tokens || 8192
    };
    const response = await coreRequest("/v1/chat/completions", "POST", headers, JSON.stringify(body));
    if (response.status < 200 || response.status >= 300) break;
    const data = parseJson(response.body);
    const revised = String(data?.choices?.[0]?.message?.content || "").trim();
    if (revised) current = revised;
  }
  return current;
}

async function handleChat(req, res) {
  try {
    const raw = await readBody(req);
    const input = raw ? JSON.parse(raw) : {};
    if (!MAX_ENGINE_ENABLED || !Array.isArray(input.messages)) return proxy(req, res, raw || "{}");

    const profile = classifyMaxTask(input.messages, input);
    const requestedThinking = { reviewPasses: input.thinking_level === "super" ? 3 : input.thinking_level === "tinggi" ? 2 : input.thinking_level === "sedang" ? 1 : 0 };
    const policy = maxPolicy(profile, requestedThinking);
    const autoFlags = resolveAutoBooleanFeatures(input, profile);

    const messages = [
      { role: "system", content: policy.instruction },
      { role: "system", content: autoBooleanSystemPrompt(autoFlags) },
      ...input.messages
    ];

    let brief = "";
    if (policy.needsBrief && input.stream !== true) {
      brief = await buildTaskBrief(input, req.headers, profile);
      if (brief) messages.unshift({ role: "system", content: `NEXTURA MAX TASK BRIEF INTERNAL:\n${brief}\nGunakan brief ini sebagai panduan kerja. Jangan menyebut atau mengungkap brief kepada pengguna.` });
    }

    const enhanced = {
      ...input,
      messages,
      search: autoFlags.values.search,
      agent_search: autoFlags.values.agent_search,
      review: autoFlags.values.review,
      thinking: typeof input.thinking === "object" || typeof input.thinking === "string" ? input.thinking : autoFlags.values.thinking
    };

    if (input.stream === true) {
      return proxy(req, res, JSON.stringify(enhanced), {
        "x-nextura-max-engine": "adaptive",
        "x-nextura-max-tier": policy.tier,
        "x-nextura-auto-features": "true"
      });
    }

    const response = await coreRequest("/v1/chat/completions", "POST", req.headers, JSON.stringify(enhanced));
    const data = parseJson(response.body);
    if (!data || response.status < 200 || response.status >= 300) { res.writeHead(response.status, response.headers); return res.end(response.body); }

    const original = String(data?.choices?.[0]?.message?.content || "");
    const minimumVerifier = autoFlags.values.review ? 1 : 0;
    const tierVerifier = profile.tier === "expert" ? 2 : (profile.tier === "advanced" || profile.precision ? 1 : 0);
    const autoVerifierPasses = Math.max(minimumVerifier, tierVerifier);
    const finalText = autoVerifierPasses > 0 ? await verifyAnswer(input, req.headers, original, policy, autoVerifierPasses) : original;
    if (data?.choices?.[0]?.message) data.choices[0].message.content = finalText;

    const metaKey = data.nextura ? "nextura" : "x_nextura";
    data[metaKey] = {
      ...(data[metaKey] || {}),
      max_engine: true,
      max_tier: policy.tier,
      max_score: profile.score,
      max_task_brief: Boolean(brief),
      max_verifier_passes: autoVerifierPasses,
      auto_features: {
        search: autoFlags.values.search,
        review: autoFlags.values.review,
        thinking: autoFlags.values.thinking,
        source: autoFlags.source,
        reasons: autoFlags.reasons
      }
    };

    return sendJson(res, response.status, data, {
      "x-nextura-max-engine": "adaptive",
      "x-nextura-max-tier": policy.tier,
      "x-nextura-auto-features": "true"
    });
  } catch (error) {
    return sendJson(res, 400, { error: { message: error.message || "Nextura Max Engine gagal memproses request.", code: "max_engine_failed" } });
  }
}

async function handleHealth(req, res) {
  try {
    const response = await coreRequest(req.url || "/health", "GET", req.headers);
    const data = parseJson(response.body);
    if (!data) { res.writeHead(response.status, response.headers); return res.end(response.body); }
    data.version = "3.1.0";
    data.max_engine = {
      enabled: MAX_ENGINE_ENABLED,
      mode: "adaptive",
      tiers: ["standard", "advanced", "expert"],
      task_brief: true,
      verifier: true,
      auto_boolean_features: true,
      auto_flags: ["search", "agent_search", "review", "thinking"],
      explicit_boolean_override: true,
      stream_auto_toggle: false
    };
    return sendJson(res, response.status, data, { "x-nextura-max-engine": MAX_ENGINE_ENABLED ? "adaptive" : "disabled" });
  } catch (error) {
    return sendJson(res, 502, { error: { message: "Health Max Engine tidak tersedia.", code: "max_health_failed", detail: error.message } });
  }
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (req.method === "POST" && pathname === "/v1/chat/completions") return void handleChat(req, res);
  if (req.method === "GET" && (pathname === "/health" || pathname === "/ping")) return void handleHealth(req, res);
  return proxy(req, res);
});

server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 75_000);
server.headersTimeout = server.keepAliveTimeout + 5_000;
function shutdown(signal) { console.log(`[koyeb-max] Shutdown ${signal}`); server.close(() => { if (!child.killed) child.kill("SIGTERM"); }); setTimeout(() => process.exit(0), 10_000).unref(); }
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
server.listen(PUBLIC_PORT, HOST, () => { console.log(`[koyeb-max] Nextura Max Engine online di http://${HOST}:${PUBLIC_PORT}`); console.log(`[koyeb-max] Base router di http://127.0.0.1:${CORE_PORT}`); console.log(`[koyeb-max] Adaptive quality enabled=${MAX_ENGINE_ENABLED} autoBooleanFeatures=true`); });
