import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const PUBLIC_PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";
const INNER_PORT = Number(process.env.TERMINAL_AGENT_V2_PORT || (PUBLIC_PORT === 8000 ? 8030 : PUBLIC_PORT + 30));
const SANDBOX_ROOT = path.resolve(process.env.TOOL_SANDBOX_ROOT || "/tmp/nextura-sandbox");
const PUBLIC_KEY = process.env.NEXTURA_API_KEY || process.env.NEXTURA_TOOL_KEY || "";

const child = spawn(process.execPath, ["terminal-agent-v2.js"], {
  env: { ...process.env, PORT: String(INNER_PORT), HOST: "127.0.0.1" },
  stdio: "inherit"
});
child.on("exit", (code, signal) => {
  console.error(`[terminal-agent-wrapper] agent v2 berhenti. code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

function bearer(req) {
  return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
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

function safeArtifact(relative = "") {
  const target = path.resolve(SANDBOX_ROOT, String(relative || ""));
  const rel = path.relative(SANDBOX_ROOT, target);
  if (!relative || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path artifact tidak valid");
  return { target, rel };
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  const map = {
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".zip": "application/zip",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };
  return map[ext] || "application/octet-stream";
}

function serveArtifact(req, res, url) {
  if (!PUBLIC_KEY || bearer(req) !== PUBLIC_KEY) {
    return sendJson(res, 401, { error: { message: "API key tidak valid.", code: "invalid_api_key" } });
  }
  try {
    const { target, rel } = safeArtifact(url.searchParams.get("path") || "");
    const stat = fs.statSync(target);
    if (!stat.isFile()) return sendJson(res, 404, { error: { message: "Artifact tidak ditemukan.", code: "artifact_not_found" } });
    const filename = path.basename(rel).replace(/[\r\n\"]/g, "_");
    res.writeHead(200, {
      "content-type": mimeFor(target),
      "content-length": stat.size,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff"
    });
    fs.createReadStream(target).pipe(res);
  } catch (error) {
    return sendJson(res, 400, { error: { message: error.message || "Artifact gagal dibuka.", code: "artifact_failed" } });
  }
}

function proxy(req, res) {
  const headers = { ...req.headers, host: `127.0.0.1:${INNER_PORT}` };
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: INNER_PORT,
    path: req.url,
    method: req.method,
    headers
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", (error) => {
    if (!res.headersSent) sendJson(res, 502, { error: { message: "Terminal agent belum siap.", code: "terminal_agent_unavailable", detail: error.message } });
    else res.end();
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/v1/artifacts/download") return serveArtifact(req, res, url);
  return proxy(req, res);
});

server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 75000);
server.headersTimeout = server.keepAliveTimeout + 5000;
function shutdown(signal) {
  console.log(`[terminal-agent-wrapper] Shutdown ${signal}`);
  server.close(() => { if (!child.killed) child.kill("SIGTERM"); });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
server.listen(PUBLIC_PORT, HOST, () => {
  console.log(`[terminal-agent-wrapper] Public agent http://${HOST}:${PUBLIC_PORT}`);
  console.log(`[terminal-agent-wrapper] Artifact download /v1/artifacts/download?path=...`);
  console.log(`[terminal-agent-wrapper] Agent v2 internal http://127.0.0.1:${INNER_PORT}`);
});
