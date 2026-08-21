import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function getText(m) {
  return m?.message?.conversation || m?.message?.extendedTextMessage?.text || m?.message?.imageMessage?.caption || m?.message?.videoMessage?.caption || "";
}

const VALID_MODES = new Set(["cepat", "pintar"]);
const DEFAULT_MODE = String(process.env.NERA_AI_DEFAULT_MODE || "cepat").toLowerCase() === "pintar" ? "pintar" : "cepat";
const MAX_TURNS = Math.max(2, Number(process.env.NERA_AI_MEMORY_TURNS || 20));
const STREAM_EDIT_MS = Math.max(700, Number(process.env.NERA_AI_STREAM_EDIT_MS || 1200));
const THINK_ANIMATION_MS = Math.max(700, Number(process.env.NERA_AI_THINK_ANIMATION_MS || 900));
const MAX_IMAGE_BYTES = Math.max(256000, Number(process.env.NERA_AI_MAX_IMAGE_BYTES || 8 * 1024 * 1024));
const SESSION_DIR = path.resolve(process.env.WA_SESSION_DIR || "/tmp/axynera-wa-session");
const MEMORY_FILE = path.resolve(process.env.NERA_AI_MEMORY_FILE || path.join(SESSION_DIR, "nera-memory.json"));

function emptyStore() { return { version: 1, aliases: {}, sessions: {} }; }
function loadStore() {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    if (!fs.existsSync(MEMORY_FILE)) return emptyStore();
    const x = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    return { version: 1, aliases: x?.aliases || {}, sessions: x?.sessions || {} };
  } catch (e) {
    console.error("[nera-memory] gagal membaca:", e.message);
    return emptyStore();
  }
}
const store = loadStore();
function saveStore() {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    const tmp = `${MEMORY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
    fs.renameSync(tmp, MEMORY_FILE);
  } catch (e) { console.error("[nera-memory] gagal menyimpan:", e.message); }
}

const norm = (v = "") => String(v || "").trim().toLowerCase();
const isLid = (v = "") => norm(v).endsWith("@lid");
const canonical = (v = "") => norm(store.aliases[norm(v)] || norm(v));
const firstLid = (arr = []) => arr.map(norm).find(isLid) || "";
const firstJid = (arr = []) => arr.map(norm).find(Boolean) || "";

function getIdentity(message) {
  const k = message?.key || {};
  const remote = norm(k.remoteJid);
  if (remote.endsWith("@g.us")) {
    const candidates = [k.participant, k.participantAlt, k.senderLid, k.senderPn, k.participantPn];
    const p = canonical(firstLid(candidates) || firstJid(candidates) || "unknown");
    return { key: `group:${remote}|user:${p}`, identity: p, chatJid: remote, groupJid: remote };
  }
  const candidates = [k.remoteJid, k.remoteJidAlt, k.senderLid, k.senderPn, k.participant, k.participantAlt];
  const id = canonical(firstLid(candidates) || firstJid(candidates) || remote);
  return { key: `dm:${id}`, identity: id, chatJid: remote || id, groupJid: null };
}

function newSession(info, mode = DEFAULT_MODE) {
  const now = Date.now();
  return { id: randomUUID(), identity: info.identity, chatJids: [...new Set([info.chatJid, info.identity].filter(Boolean))], groupJid: info.groupJid, mode, messages: [], createdAt: now, updatedAt: now };
}
function getSession(info) {
  if (!store.sessions[info.key]) { store.sessions[info.key] = newSession(info); saveStore(); }
  return store.sessions[info.key];
}
const trimMessages = (m = []) => m.slice(-(MAX_TURNS * 2));
function setChatMode(info, mode) {
  if (!VALID_MODES.has(mode)) return false;
  const s = getSession(info); s.mode = mode; s.updatedAt = Date.now(); saveStore(); return true;
}
function migrateAlias(pn, lid, log) {
  const a = norm(pn), b = norm(lid); if (!a || !b || !isLid(b)) return;
  store.aliases[a] = b; store.aliases[b] = b;
  const oldKey = `dm:${a}`, newKey = `dm:${b}`;
  if (store.sessions[oldKey]) {
    if (!store.sessions[newKey]) store.sessions[newKey] = store.sessions[oldKey];
    else store.sessions[newKey].messages = trimMessages([...(store.sessions[oldKey].messages || []), ...(store.sessions[newKey].messages || [])]);
    store.sessions[newKey].identity = b; delete store.sessions[oldKey];
  }
  for (const [k, s] of Object.entries(store.sessions)) {
    if (!k.includes(`|user:${a}`)) continue;
    const nk = k.replace(`|user:${a}`, `|user:${b}`);
    if (!store.sessions[nk]) { s.identity = b; store.sessions[nk] = s; }
    delete store.sessions[k];
  }
  saveStore(); log?.("ai_lid_mapping", { pn: a, lid: b });
}
function resetSessionsForChat(jid, log) {
  const a = norm(jid), b = canonical(a); let removed = 0;
  for (const [k, s] of Object.entries(store.sessions)) {
    const chats = (s.chatJids || []).map(norm);
    if (k === `dm:${a}` || k === `dm:${b}` || s.groupJid === a || chats.includes(a) || chats.includes(b)) { delete store.sessions[k]; removed++; }
  }
  if (removed) saveStore(); log?.("ai_memory_reset", { jid: a, removed, reason: "chat_deleted" });
}

function parseSseBlock(block) {
  let event = "message"; const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join("\n") };
}
function extractSseText(payload) {
  if (!payload || payload === "[DONE]") return { type: "none", text: "" };
  try {
    const d = JSON.parse(payload);
    const delta = d?.choices?.[0]?.delta?.content ?? d?.delta ?? d?.content?.delta;
    if (delta != null) return { type: "delta", text: String(delta) };
    const full = d?.choices?.[0]?.message?.content ?? d?.message?.content;
    if (full != null) return { type: "full", text: String(full) };
    if (typeof d?.text === "string") return { type: "delta", text: d.text };
    if (typeof d?.content === "string") return { type: "delta", text: d.content };
  } catch {}
  return { type: "none", text: "" };
}
function stripHiddenReasoning(v = "") {
  let t = String(v || "");
  t = t.replace(/<(think|reasoning|analysis)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  t = t.replace(/<(think|reasoning|analysis)\b[^>]*>[\s\S]*$/gi, "");
  t = t.replace(/<\/?(?:think|reasoning|analysis)\b[^>]*>/gi, "");
  return t.trim();
}
function buildUserContent(prompt, media) {
  const text = String(prompt || "").trim() || (media?.type === "image" ? "Jelaskan gambar ini." : "Halo");
  if (!media || media.type !== "image" || !media.path || !fs.existsSync(media.path)) return text;
  const stat = fs.statSync(media.path);
  if (stat.size > MAX_IMAGE_BYTES) throw new Error(`Gambar terlalu besar (${Math.ceil(stat.size / 1024 / 1024)} MB). Maksimal ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`);
  const b64 = fs.readFileSync(media.path).toString("base64");
  return [{ type: "text", text }, { type: "image_url", image_url: { url: `data:${media.mimetype || "image/jpeg"};base64,${b64}` } }];
}

function headers(apiKey, stream) {
  const h = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "User-Agent": "Axynera-WA-Bot/1.0"
  };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}
function isHtml(body = "", contentType = "") {
  const s = String(body || "").trim().toLowerCase();
  return String(contentType || "").toLowerCase().includes("text/html") || s.startsWith("<!doctype html") || s.startsWith("<html") || s.includes("<title>cloudflare");
}
function safeHttpError(status, body, contentType) {
  if (isHtml(body, contentType)) {
    const e = new Error(`Nera gateway sedang bermasalah (HTTP ${status}).`); e.code = "NERA_GATEWAY_HTML"; e.status = status; return e;
  }
  try {
    const d = JSON.parse(body || "{}");
    const msg = d?.error?.message || d?.message;
    if (msg) { const e = new Error(String(msg)); e.status = status; return e; }
  } catch {}
  const e = new Error(`Nera API HTTP ${status}.`); e.status = status; return e;
}
async function doNeraRequest({ baseUrl, model, mode, messages, apiKey, timeoutMs, stream = true, includeModel = true }) {
  const payload = { mode, stream, messages };
  if (includeModel && model) payload.model = model;
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: headers(apiKey, stream),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
}
async function parseNonStreamResponse(r, { log, jid, sessionId, model, mode }) {
  const body = await r.text().catch(() => "");
  const ct = r.headers.get("content-type") || "";
  if (!r.ok) {
    log?.("ai_nonstream_error", { jid, sessionId, status: r.status, contentType: ct, body: body.slice(0, 1600) });
    throw safeHttpError(r.status, body, ct);
  }
  if (isHtml(body, ct)) {
    log?.("ai_nonstream_html", { jid, sessionId, status: r.status, contentType: ct, body: body.slice(0, 1600) });
    throw safeHttpError(r.status, body, ct);
  }
  let data;
  try { data = JSON.parse(body); }
  catch { throw new Error("Nera non-stream mengirim JSON tidak valid."); }
  const answer = stripHiddenReasoning(data?.choices?.[0]?.message?.content || data?.message?.content || data?.text || "");
  if (!answer) throw new Error("Nera non-stream tidak mengirim jawaban.");
  log?.("ai_response", { jid, sessionId, model, mode, stream: false, text: answer });
  return answer;
}

async function askNeraStream({ messages, mode, log, jid, sessionId, onVisibleText, onThinking }) {
  const baseUrl = String(process.env.NERA_AI_BASE_URL || "https://api.axynera.my.id").replace(/\/+$/, "");
  const model = String(process.env.NERA_AI_MODEL || "Nera-Plus.5").trim() || "Nera-Plus.5";
  const apiKey = String(process.env.NERA_AI_API_KEY || "").trim();
  const timeoutMs = Number(process.env.NERA_AI_TIMEOUT_MS || 120000);
  log?.("ai_request", { jid, sessionId, model, mode, stream: true, historyMessages: Math.max(0, messages.length - 1) });

  let r = await doNeraRequest({ baseUrl, model, mode, messages, apiKey, timeoutMs, stream: true, includeModel: true });
  if (r.status === 403) {
    const b = await r.text().catch(() => "");
    log?.("ai_403", { jid, sessionId, withModel: true, contentType: r.headers.get("content-type") || "", body: b.slice(0, 1200) });
    r = await doNeraRequest({ baseUrl, model, mode, messages, apiKey, timeoutMs, stream: true, includeModel: false });
  }

  if (!r.ok || (r.headers.get("content-type") || "").toLowerCase().includes("text/html")) {
    const b = await r.text().catch(() => "");
    const ct = r.headers.get("content-type") || "";
    log?.("ai_stream_fallback", { jid, sessionId, status: r.status, contentType: ct, html: isHtml(b, ct), body: b.slice(0, 1600) });

    let fallback = await doNeraRequest({ baseUrl, model, mode, messages, apiKey, timeoutMs, stream: false, includeModel: true });
    if (fallback.status === 403) {
      const fb = await fallback.text().catch(() => "");
      log?.("ai_nonstream_403", { jid, sessionId, withModel: true, body: fb.slice(0, 1200) });
      fallback = await doNeraRequest({ baseUrl, model, mode, messages, apiKey, timeoutMs, stream: false, includeModel: false });
    }
    const answer = await parseNonStreamResponse(fallback, { log, jid, sessionId, model, mode });
    onVisibleText?.(answer);
    return answer;
  }

  if (!r.body) throw new Error("Nera SSE tidak mengirim response body.");
  const reader = r.body.getReader(); const decoder = new TextDecoder();
  let buffer = "", raw = "";
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, i); buffer = buffer.slice(i + 2);
      const { event, data } = parseSseBlock(block);
      if (!data || data === "[DONE]") continue;
      if (event === "thinking" || event === "reasoning") { onThinking?.(); continue; }
      const piece = extractSseText(data); if (!piece.text) continue;
      raw = piece.type === "full" ? piece.text : raw + piece.text;
      const visible = stripHiddenReasoning(raw); if (visible) onVisibleText?.(visible); else onThinking?.();
    }
  }
  const answer = stripHiddenReasoning(raw);
  if (!answer) throw new Error("Nera tidak mengirim balasan yang bisa ditampilkan.");
  log?.("ai_response", { jid, sessionId, model, mode, stream: true, text: answer });
  return answer;
}

export async function onLidMapping({ mapping, log }) { migrateAlias(mapping?.pn, mapping?.lid, log); }
export async function onChatDelete({ jid, log }) { resetSessionsForChat(jid, log); }
export async function onMessagesDelete({ event, log }) { if (event?.jid && event?.all === true) resetSessionsForChat(event.jid, log); }

export default async function neraAiPlugin({ sock, message, media, log }) {
  const jid = message?.key?.remoteJid;
  if (!jid || message?.key?.fromMe || jid === "status@broadcast") return;
  const raw = String(getText(message)).trim(); const hasImage = media?.type === "image";
  if (!raw && !hasImage) return;

  const lower = raw.toLowerCase(); const info = getIdentity(message); const session = getSession(info);
  const modeMatch = raw.match(/^\.?(?:mode|nera\s+mode)(?:\s+(cepat|pintar))?\s*$/i);
  if (modeMatch && !hasImage) {
    const requested = String(modeMatch[1] || "").toLowerCase();
    if (!requested) { await sock.sendMessage(jid, { text: `⚙️ *Mode Nera saat ini: ${session.mode || DEFAULT_MODE}*\n\n• *.mode cepat* — respons cepat\n• *.mode pintar* — penalaran lebih dalam` }, { quoted: message }); return; }
    setChatMode(info, requested);
    await sock.sendMessage(jid, { text: requested === "pintar" ? "🧠 Mode Nera diubah ke *pintar*." : "⚡ Mode Nera diubah ke *cepat*." }, { quoted: message }); return;
  }
  if (!hasImage && /^\.(?:new|reset|newchat|lupain)\s*$/i.test(raw)) {
    delete store.sessions[info.key]; store.sessions[info.key] = newSession(info, session.mode || DEFAULT_MODE); saveStore();
    await sock.sendMessage(jid, { text: "🆕 Sesi Nera baru dibuat." }, { quoted: message }); return;
  }

  const cmd = raw.match(/^(?:\.ai|ai)\s+([\s\S]+)/i);
  const autoReply = String(process.env.WA_AI_AUTO_REPLY || "true").toLowerCase() !== "false";
  if (!hasImage && !cmd && (!autoReply || lower === "ping" || raw.startsWith("."))) return;
  const prompt = cmd ? cmd[1].trim() : (raw || "Jelaskan gambar ini."); const mode = session.mode || DEFAULT_MODE;
  let userContent;
  try { userContent = buildUserContent(prompt, media); }
  catch (e) { await sock.sendMessage(jid, { text: e.message }, { quoted: message }).catch(() => {}); return; }

  const messages = trimMessages([...(session.messages || []).map(m => ({ role: m.role, content: m.content })), { role: "user", content: userContent }]);
  let placeholder = null, lastEditAt = 0, lastRendered = "", visibleStarted = false, frame = 0, timer = null;
  const stopAnim = () => { if (timer) clearInterval(timer); timer = null; };
  try {
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    const base = hasImage ? "🖼️ Nera sedang melihat gambar" : "🧠 Nera sedang Berfikir";
    placeholder = await sock.sendMessage(jid, { text: `${base}...` }, { quoted: message });
    timer = setInterval(() => {
      if (!placeholder?.key || visibleStarted) return;
      frame = (frame + 1) % 3;
      void sock.sendMessage(jid, { text: `${base}${".".repeat(frame + 1)}`, edit: placeholder.key }).catch(() => {});
    }, THINK_ANIMATION_MS); timer.unref?.();

    const render = async (text, force = false) => {
      const clean = stripHiddenReasoning(text); if (!clean || clean === lastRendered) return true;
      visibleStarted = true; stopAnim();
      if (!force && Date.now() - lastEditAt < STREAM_EDIT_MS) return true;
      lastEditAt = Date.now(); lastRendered = clean;
      if (placeholder?.key) {
        try {
          await sock.sendMessage(jid, { text: clean, edit: placeholder.key });
          return true;
        } catch (e) {
          log?.("ai_stream_edit_error", { jid, error: e.message });
        }
      }
      try {
        await sock.sendMessage(jid, { text: clean }, { quoted: message });
        return true;
      } catch (e) {
        log?.("ai_send_fallback_error", { jid, error: e.message });
        return false;
      }
    };

    const answer = await askNeraStream({ messages, mode, log, jid, sessionId: session.id, onVisibleText: v => void render(v), onThinking: () => {} });
    const rendered = await render(answer, true);
    if (!rendered) throw new Error("Jawaban Nera diterima, tetapi gagal dikirim ke WhatsApp.");

    session.messages = trimMessages([...(session.messages || []), { role: "user", content: hasImage ? `[Gambar] ${prompt}` : prompt }, { role: "assistant", content: answer }]);
    session.mode = mode; session.updatedAt = Date.now(); session.chatJids = [...new Set([...(session.chatJids || []), jid, info.identity].filter(Boolean))]; saveStore();
  } catch (e) {
    stopAnim();
    const err = e?.message || String(e);
    log?.("ai_error", { jid, identity: info.identity, sessionId: session.id, mode, status: e?.status || null, code: e?.code || null, error: err, text: prompt, hasImage });
    console.error("[nera-ai]", err);
    let friendly = "Nera sedang bermasalah, coba lagi sebentar.";
    if (e?.code === "NERA_GATEWAY_HTML") friendly = `Nera gateway sedang bermasalah (HTTP ${e.status || "?"}). Coba lagi sebentar.`;
    else if (e?.status === 403 || err.includes("403")) friendly = "Nera API menolak request (403). Cek konfigurasi API/Cloudflare.";
    let sent = false;
    if (placeholder?.key) {
      try { await sock.sendMessage(jid, { text: friendly, edit: placeholder.key }); sent = true; } catch {}
    }
    if (!sent) await sock.sendMessage(jid, { text: friendly }, { quoted: message }).catch(() => {});
  } finally {
    stopAnim(); await sock.sendPresenceUpdate("paused", jid).catch(() => {});
  }
}
