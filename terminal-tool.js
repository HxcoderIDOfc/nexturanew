import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import dns from "node:dns/promises";
import net from "node:net";

const PORT = Number(process.env.TOOL_INTERNAL_PORT || 8004);
const HOST = "127.0.0.1";
const TOOL_KEY = process.env.NEXTURA_TOOL_KEY || "";
const ENABLED = String(process.env.ENABLE_TERMINAL_TOOL || "false").toLowerCase() === "true";
const WORKSPACE_ROOT = path.resolve(process.env.TOOL_WORKSPACE_ROOT || process.cwd());
const MAX_OUTPUT = Number(process.env.TOOL_MAX_OUTPUT_BYTES || 20000);
const TIMEOUT_MS = Number(process.env.TOOL_COMMAND_TIMEOUT_MS || 120000);

const SAFE_COMMANDS = new Map([
  ["git_status", ["git", ["status", "--short", "--branch"]]],
  ["git_pull", ["git", ["pull", "--ff-only"]]],
  ["npm_install", ["npm", ["install"]]],
  ["npm_check", ["npm", ["run", "check"]]],
  ["npm_test", ["npm", ["test"]]],
  ["npm_build", ["npm", ["run", "build"]]],
  ["wrangler_whoami", ["npx", ["--yes", "wrangler", "whoami"]]],
  ["wrangler_deploy", ["npx", ["--yes", "wrangler", "deploy"]]]
]);

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function token(req) {
  return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
}

function auth(req, res) {
  if (!ENABLED) {
    send(res, 503, { error: { message: "Terminal tool belum diaktifkan.", code: "tool_disabled" } });
    return false;
  }
  if (!TOOL_KEY) {
    send(res, 503, { error: { message: "NEXTURA_TOOL_KEY belum dikonfigurasi.", code: "tool_key_missing" } });
    return false;
  }
  if (token(req) !== TOOL_KEY) {
    send(res, 401, { error: { message: "Tool key tidak valid.", code: "invalid_tool_key" } });
    return false;
  }
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Payload terlalu besar");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function safeCwd(relative = ".") {
  const resolved = path.resolve(WORKSPACE_ROOT, String(relative || "."));
  const rel = path.relative(WORKSPACE_ROOT, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("cwd di luar workspace ditolak");
  return resolved;
}

function run(file, args, cwd) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(file, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => { stdout = (stdout + d).slice(-MAX_OUTPUT); });
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-MAX_OUTPUT); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, exit_code: null, stdout, stderr: error.message, timed_out: false, latency_ms: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, exit_code: code, stdout, stderr, timed_out: timedOut, latency_ms: Date.now() - startedAt });
    });
  });
}

function isPrivateIp(ip) {
  if (!net.isIP(ip)) return true;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("169.254.")) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  return false;
}

async function validatePublicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Hanya HTTPS yang diizinkan");
  const records = await dns.lookup(url.hostname, { all: true });
  if (!records.length || records.some((r) => isPrivateIp(r.address))) throw new Error("Host lokal/internal ditolak");
  return url;
}

async function testApi(input) {
  const base = await validatePublicUrl(input.base_url || input.url);
  const endpoint = new URL(input.path || "/v1/chat/completions", base);
  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${String(input.api_key || "")}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: input.model,
      messages: [{ role: "user", content: input.prompt || "Balas tepat: TEST BERHASIL" }],
      stream: false,
      ...(input.extra && typeof input.extra === "object" ? input.extra : {})
    }),
    signal: AbortSignal.timeout(Number(input.timeout_ms || 60000))
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, MAX_OUTPUT) }; }
  return {
    ok: response.ok,
    status: response.status,
    latency_ms: Date.now() - startedAt,
    model: data?.model || input.model || null,
    content: data?.choices?.[0]?.message?.content || null,
    error: data?.error || null,
    raw: data?.choices ? undefined : data?.raw
  };
}

async function safeDelete(input) {
  const target = safeCwd(input.path);
  const rel = path.relative(WORKSPACE_ROOT, target);
  if (!rel || rel === ".") throw new Error("Root workspace tidak boleh dihapus");
  if (input.confirm !== `HAPUS ${rel}`) {
    return { ok: false, confirmation_required: true, confirm_text: `HAPUS ${rel}`, target: rel };
  }
  await fs.rm(target, { recursive: true, force: false });
  return { ok: true, deleted: rel };
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname === "/health") return send(res, 200, { ok: true, service: "Nextura Terminal Tool", enabled: ENABLED });
  if (!auth(req, res)) return;

  try {
    if (req.method === "GET" && pathname === "/v1/tools/status") {
      return send(res, 200, {
        ok: true,
        enabled: ENABLED,
        workspace_root: WORKSPACE_ROOT,
        commands: [...SAFE_COMMANDS.keys()],
        cloudflare_token_configured: Boolean(process.env.CLOUDFLARE_API_TOKEN),
        cloudflare_account_configured: Boolean(process.env.CLOUDFLARE_ACCOUNT_ID)
      });
    }

    if (req.method === "POST" && pathname === "/v1/tools/exec") {
      const body = await readJson(req);
      const spec = SAFE_COMMANDS.get(String(body.action || ""));
      if (!spec) return send(res, 400, { error: { message: "Action tidak diizinkan.", code: "action_not_allowed" } });
      const cwd = safeCwd(body.cwd || ".");
      const result = await run(spec[0], spec[1], cwd);
      return send(res, result.ok ? 200 : 500, { action: body.action, cwd: path.relative(WORKSPACE_ROOT, cwd) || ".", ...result });
    }

    if (req.method === "POST" && pathname === "/v1/tools/test-api") {
      const body = await readJson(req);
      return send(res, 200, await testApi(body));
    }

    if (req.method === "POST" && pathname === "/v1/tools/delete") {
      const body = await readJson(req);
      const result = await safeDelete(body);
      return send(res, result.ok ? 200 : 409, result);
    }

    return send(res, 404, { error: { message: "Endpoint tool tidak ditemukan.", code: "not_found" } });
  } catch (error) {
    return send(res, 400, { error: { message: error.message || "Tool gagal dijalankan.", code: "tool_failed" } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[terminal-tool] Online di http://${HOST}:${PORT}`);
  console.log(`[terminal-tool] Enabled=${ENABLED} workspace=${WORKSPACE_ROOT}`);
});
