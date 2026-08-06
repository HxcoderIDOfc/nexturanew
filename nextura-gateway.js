import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const PUBLIC_PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";
const INTERNAL_PORT = Number(process.env.GATEWAY_INTERNAL_PORT || (PUBLIC_PORT === 8000 ? 8002 : PUBLIC_PORT + 2));
const ROUTER_PORT = Number(process.env.ROUTER_INTERNAL_PORT || INTERNAL_PORT + 1);

const AI_NAME = process.env.NEXTURA_AI_NAME || "Nextura AI";
const MODEL_FAMILY = process.env.NEXTURA_MODEL_FAMILY || "Nextura Cortexa";
const DEVELOPER = process.env.NEXTURA_DEVELOPER || "Nextura";
const COMPANY = process.env.NEXTURA_COMPANY || "Nextura";
const PRO_MODEL_ID = process.env.NEXTURA_PRO_MODEL_ID || "Nextura/cortexa-pro";
const PRO_MODEL_NAME = process.env.NEXTURA_PRO_MODEL_NAME || "Nextura Cortexa Pro";
const MAX_MODEL_ID = process.env.NEXTURA_MAX_MODEL_ID || "Nextura/cortexa-max";
const MAX_MODEL_NAME = process.env.NEXTURA_MAX_MODEL_NAME || "Nextura Cortexa Max";

const child = spawn(process.execPath, ["koyeb.js"], {
  env: {
    ...process.env,
    PORT: String(INTERNAL_PORT),
    INTERNAL_PORT: String(ROUTER_PORT),
    HOST: "127.0.0.1"
  },
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  console.error(`[nextura-json] Router berhenti. code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

function modelName(id) {
  if (id === MAX_MODEL_ID) return MAX_MODEL_NAME;
  return PRO_MODEL_NAME;
}

function nexturaId() {
  return `nextura_${crypto.randomBytes(12).toString("hex")}`;
}

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
  const publicModel = data.model || PRO_MODEL_ID;
  const choice = data?.choices?.[0] || {};
  const sourceMeta = data.nextura || data.x_nextura || {};

  return {
    id: String(data.id || nexturaId()).replace(/^devshard-/i, "nextura-"),
    object: "chat.completion",
    created: Number(data.created || Math.floor(Date.now() / 1000)),
    model: publicModel,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: choice?.message?.content || ""
      },
      finish_reason: choice.finish_reason || "stop"
    }],
    usage: normalizeUsage(data.usage),
    nextura: {
      schema: "nextura.chat.v1",
      ai_name: sourceMeta.ai_name || AI_NAME,
      model_id: publicModel,
      model_name: sourceMeta.model_name || modelName(publicModel),
      model_family: MODEL_FAMILY,
      developer: sourceMeta.developer || DEVELOPER,
      company: COMPANY,
      agent_search: Boolean(sourceMeta.agent_search),
      identity_enforced: sourceMeta.identity_enforced !== false,
      deep_thinking: Boolean(sourceMeta.deep_thinking),
      thinking_visible: Boolean(sourceMeta.thinking_visible),
      latency_ms: Number(sourceMeta.latency_ms || 0)
    }
  };
}

function proxy(req, res) {
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: INTERNAL_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${INTERNAL_PORT}`
    }
  }, (upstreamRes) => {
    const contentType = String(upstreamRes.headers["content-type"] || "");
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    const shouldRewrite =
      req.method === "POST" &&
      pathname === "/v1/chat/completions" &&
      contentType.includes("application/json") &&
      upstreamRes.statusCode >= 200 &&
      upstreamRes.statusCode < 300;

    if (!shouldRewrite) {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
      return;
    }

    const chunks = [];
    upstreamRes.on("data", (chunk) => chunks.push(chunk));
    upstreamRes.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = JSON.stringify(toNexturaJson(JSON.parse(raw)));
        const headers = {
          ...upstreamRes.headers,
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "x-nextura-schema": "nextura.chat.v1"
        };
        delete headers["transfer-encoding"];
        res.writeHead(upstreamRes.statusCode || 200, headers);
        res.end(body);
      } catch {
        const body = JSON.stringify({
          error: {
            message: "Gagal membentuk JSON Nextura.",
            type: "nextura_gateway_error",
            code: "json_transform_failed"
          }
        });
        res.writeHead(502, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body)
        });
        res.end(body);
      }
    });
  });

  upstream.on("error", (error) => {
    const body = JSON.stringify({
      error: {
        message: "Nextura router belum siap atau tidak dapat dihubungi.",
        type: "nextura_gateway_error",
        code: "router_unavailable",
        detail: error.message
      }
    });
    res.writeHead(502, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body)
    });
    res.end(body);
  });

  req.pipe(upstream);
}

const server = http.createServer(proxy);
server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 75_000);
server.headersTimeout = server.keepAliveTimeout + 5_000;

function shutdown(signal) {
  console.log(`[nextura-json] Shutdown ${signal}`);
  server.close(() => {
    if (!child.killed) child.kill("SIGTERM");
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

server.listen(PUBLIC_PORT, HOST, () => {
  console.log(`[nextura-json] Gateway online di http://${HOST}:${PUBLIC_PORT}`);
  console.log(`[nextura-json] Koyeb router internal di http://127.0.0.1:${INTERNAL_PORT}`);
  console.log(`[nextura-json] AI router internal di http://127.0.0.1:${ROUTER_PORT}`);
});