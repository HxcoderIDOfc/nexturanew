import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function getText(message) {
  return message?.message?.conversation
    || message?.message?.extendedTextMessage?.text
    || message?.message?.imageMessage?.caption
    || message?.message?.videoMessage?.caption
    || "";
}

const VALID_MODES = new Set(["cepat", "pintar"]);
const DEFAULT_MODE = String(process.env.NERA_AI_DEFAULT_MODE || "cepat").toLowerCase() === "pintar" ? "pintar" : "cepat";
const MAX_TURNS = Math.max(2, Number(process.env.NERA_AI_MEMORY_TURNS || 20));
const STREAM_EDIT_MS = Math.max(700, Number(process.env.NERA_AI_STREAM_EDIT_MS || 1200));
const SESSION_DIR = path.resolve(process.env.WA_SESSION_DIR || "/tmp/nextura-wa-session");
const MEMORY_FILE = path.resolve(process.env.NERA_AI_MEMORY_FILE || path.join(SESSION_DIR, "nera-memory.json"));

function emptyStore() { return { version: 1, aliases: {}, sessions: {} }; }
function loadStore() {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    if (!fs.existsSync(MEMORY_FILE)) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    return { version: 1, aliases: parsed?.aliases || {}, sessions: parsed?.sessions || {} };
  } catch (error) {
    console.error("[nera-memory] gagal membaca memory:", error.message);
    return emptyStore();
  }
}
const store = loadStore();
function saveStore() {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    const temp = `${MEMORY_FILE}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(store, null, 2), "utf8");
    fs.renameSync(temp, MEMORY_FILE);
  } catch (error) {
    console.error("[nera-memory] gagal menyimpan memory:", error.message);
  }
}
function normalizeJid(v = "") { return String(v || "").trim().toLowerCase(); }
function isLid(jid = "") { return normalizeJid(jid).endsWith("@lid"); }
function canonicalJid(jid = "") { const c = normalizeJid(jid); return normalizeJid(store.aliases[c] || c); }
function firstLid(values = []) { return values.map(normalizeJid).find(isLid) || ""; }
function firstJid(values = []) { return values.map(normalizeJid).find(Boolean) || ""; }
function getIdentity(message) {
  const key = message?.key || {};
  const remote = normalizeJid(key.remoteJid);
  if (remote.endsWith("@g.us")) {
    const candidates = [key.participant, key.participantAlt, key.senderLid, key.senderPn, key.participantPn];
    const participant = canonicalJid(firstLid(candidates) || firstJid(candidates) || "unknown");
    return { key: `group:${remote}|user:${participant}`, identity: participant, chatJid: remote, groupJid: remote };
  }
  const candidates = [key.remoteJid, key.remoteJidAlt, key.senderLid, key.senderPn, key.participant, key.participantAlt];
  const identity = canonicalJid(firstLid(candidates) || firstJid(candidates) || remote);
  return { key: `dm:${identity}`, identity, chatJid: remote || identity, groupJid: null };
}
function newSession(info, mode = DEFAULT_MODE) {
  const now = Date.now();
  return { id: randomUUID(), identity: info.identity, chatJids: [...new Set([info.chatJid, info.identity].filter(Boolean))], groupJid: info.groupJid, mode, messages: [], createdAt: now, updatedAt: now };
}
function getSession(info) {
  let session = store.sessions[info.key];
  if (!session) {
    session = newSession(info);
    store.sessions[info.key] = session;
    saveStore();
  }
  return session;
}
function trimMessages(messages = []) { return messages.slice(-(MAX_TURNS * 2)); }
function setChatMode(info, mode) {
  if (!VALID_MODES.has(mode)) return false;
  const session = getSession(info);
  session.mode = mode;
  session.updatedAt = Date.now();
  saveStore();
  return true;
}
function migrateAlias(pn, lid, log) {
  const cleanPn = normalizeJid(pn), cleanLid = normalizeJid(lid);
  if (!cleanPn || !cleanLid || !isLid(cleanLid)) return;
  store.aliases[cleanPn] = cleanLid;
  store.aliases[cleanLid] = cleanLid;
  const oldKey = `dm:${cleanPn}`, newKey = `dm:${cleanLid}`;
  if (store.sessions[oldKey]) {
    if (!store.sessions[newKey]) store.sessions[newKey] = store.sessions[oldKey];
    else store.sessions[newKey].messages = trimMessages([...(store.sessions[oldKey].messages || []), ...(store.sessions[newKey].messages || [])]);
    store.sessions[newKey].identity = cleanLid;
    delete store.sessions[oldKey];
  }
  for (const [key, session] of Object.entries(store.sessions)) {
    if (!key.includes(`|user:${cleanPn}`)) continue;
    const migrated = key.replace(`|user:${cleanPn}`, `|user:${cleanLid}`);
    if (!store.sessions[migrated]) { session.identity = cleanLid; store.sessions[migrated] = session; }
    delete store.sessions[key];
  }
  saveStore();
  log?.("ai_lid_mapping", { pn: cleanPn, lid: cleanLid });
}
function resetSessionsForChat(jid, log) {
  const clean = normalizeJid(jid), canonical = canonicalJid(clean);
  let removed = 0;
  for (const [key, session] of Object.entries(store.sessions)) {
    const chats = (session.chatJids || []).map(normalizeJid);
    if (key === `dm:${clean}` || key === `dm:${canonical}` || session.groupJid === clean || chats.includes(clean) || chats.includes(canonical)) {
      delete store.sessions[key];
      removed++;
    }
  }
  if (removed) saveStore();
  log?.("ai_memory_reset", { jid: clean, removed, reason: "chat_deleted" });
}

function parseSseBlock(block) {
  let event = "message";
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  return { event, data: dataLines.join("\n") };
}
function extractDelta(payload) {
  if (!payload || payload === "[DONE]") return "";
  try {
    const data = JSON.parse(payload);
    return String(data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.message?.content ?? data?.delta ?? data?.content?.delta ?? data?.text ?? "");
  } catch {
    return "";
  }
}

function neraHeaders(apiKey) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": "Axynera-WhatsApp-Bot/1.0"
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function doNeraRequest({ baseUrl, model, mode, messages, apiKey, timeoutMs, includeModel = true }) {
  const payload = { mode, stream: true, messages };
  if (includeModel && model) payload.model = model;
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: neraHeaders(apiKey),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
}

async function askNeraStream({ messages, mode, log, jid, sessionId, onDelta, onThinking }) {
  const baseUrl = String(process.env.NERA_AI_BASE_URL || "https://api.axynera.my.id").replace(/\/+$/, "");
  const model = String(process.env.NERA_AI_MODEL || "Nera-Plus.5").trim() || "Nera-Plus.5";
  const apiKey = String(process.env.NERA_AI_API_KEY || "").trim();
  const timeoutMs = Number(process.env.NERA_AI_TIMEOUT_MS || 120000);

  log?.("ai_request", { jid, sessionId, model, mode, stream: true, historyMessages: Math.max(0, messages.length - 1) });
  let response = await doNeraRequest({ baseUrl, model, mode, messages, apiKey, timeoutMs, includeModel: true });

  if (response.status === 403) {
    const firstBody = await response.text().catch(() => "");
    log?.("ai_403", { jid, sessionId, withModel: true, body: firstBody.slice(0, 1000) });
    console.error("[nera-ai] 403 dengan model, retry payload kompatibel:", firstBody.slice(0, 500));
    response = await doNeraRequest({ baseUrl, model, mode, messages, apiKey, timeoutMs, includeModel: false });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    log?.("ai_http_error", { jid, sessionId, status: response.status, body: body.slice(0, 1000) });
    let detail = body;
    try {
      const data = JSON.parse(body);
      detail = data?.error?.message || data?.message || body;
    } catch {}
    throw new Error(detail || `Nera API ${response.status}`);
  }
  if (!response.body) throw new Error("Nera SSE tidak mengirim response body.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", answer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const { event, data } = parseSseBlock(block);
      if (!data || data === "[DONE]") continue;
      if (event === "thinking") {
        try { onThinking?.(JSON.parse(data)); } catch { onThinking?.({ status: data }); }
        continue;
      }
      const delta = extractDelta(data);
      if (delta) {
        answer += delta;
        onDelta?.(answer, delta);
      }
    }
  }
  if (!answer.trim()) throw new Error("Nera tidak mengirim balasan SSE.");
  log?.("ai_response", { jid, sessionId, model, mode, stream: true, text: answer });
  return answer.trim();
}

export async function onLidMapping({ mapping, log }) { migrateAlias(mapping?.pn, mapping?.lid, log); }
export async function onChatDelete({ jid, log }) { resetSessionsForChat(jid, log); }
export async function onMessagesDelete({ event, log }) { if (event?.jid && event?.all === true) resetSessionsForChat(event.jid, log); }

export default async function neraAiPlugin({ sock, message, log }) {
  const jid = message?.key?.remoteJid;
  if (!jid || message?.key?.fromMe || jid === "status@broadcast") return;
  const raw = String(getText(message)).trim();
  if (!raw) return;
  const lower = raw.toLowerCase();
  const identityInfo = getIdentity(message);
  const session = getSession(identityInfo);

  const modeMatch = raw.match(/^\.?(?:mode|nera\s+mode)(?:\s+(cepat|pintar))?\s*$/i);
  if (modeMatch) {
    const requested = String(modeMatch[1] || "").toLowerCase();
    if (!requested) {
      await sock.sendMessage(jid, { text: `⚙️ *Mode Nera saat ini: ${session.mode || DEFAULT_MODE}*\n\n• *.mode cepat* — respons cepat\n• *.mode pintar* — penalaran lebih dalam` }, { quoted: message });
      return;
    }
    setChatMode(identityInfo, requested);
    await sock.sendMessage(jid, { text: requested === "pintar" ? "🧠 Mode Nera diubah ke *pintar*." : "⚡ Mode Nera diubah ke *cepat*." }, { quoted: message });
    return;
  }

  if (/^\.(?:new|reset|newchat|lupain)\s*$/i.test(raw)) {
    delete store.sessions[identityInfo.key];
    store.sessions[identityInfo.key] = newSession(identityInfo, session.mode || DEFAULT_MODE);
    saveStore();
    await sock.sendMessage(jid, { text: "🆕 Sesi Nera baru dibuat." }, { quoted: message });
    return;
  }

  const commandMatch = raw.match(/^(?:\.ai|ai)\s+([\s\S]+)/i);
  const autoReply = String(process.env.WA_AI_AUTO_REPLY || "true").toLowerCase() !== "false";
  if (!commandMatch && (!autoReply || lower === "ping" || raw.startsWith("."))) return;
  const prompt = commandMatch ? commandMatch[1].trim() : raw;
  if (!prompt) return;

  const mode = session.mode || DEFAULT_MODE;
  const messages = trimMessages([...(session.messages || []), { role: "user", content: prompt }]);
  let placeholder = null, lastEditAt = 0, lastRendered = "";

  try {
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    placeholder = await sock.sendMessage(jid, { text: mode === "pintar" ? "🧠 Nera sedang berpikir…" : "✨ Nera sedang menjawab…" }, { quoted: message });

    const render = async (text, force = false) => {
      const clean = String(text || "").trim();
      if (!clean || !placeholder?.key || clean === lastRendered) return;
      if (!force && Date.now() - lastEditAt < STREAM_EDIT_MS) return;
      lastEditAt = Date.now();
      lastRendered = clean;
      await sock.sendMessage(jid, { text: clean, edit: placeholder.key }).catch((e) => log?.("ai_stream_edit_error", { jid, error: e.message }));
    };

    const answer = await askNeraStream({
      messages, mode, log, jid, sessionId: session.id,
      onDelta: (full) => void render(full),
      onThinking: (info) => {
        if (mode === "pintar" && !lastRendered) {
          const status = String(info?.status || "Nera sedang berpikir").trim();
          if (status) void render(`🧠 ${status}…`);
        }
      }
    });

    await render(answer, true);
    session.messages = trimMessages([...messages, { role: "assistant", content: answer }]);
    session.mode = mode;
    session.updatedAt = Date.now();
    session.chatJids = [...new Set([...(session.chatJids || []), jid, identityInfo.identity].filter(Boolean))];
    saveStore();
  } catch (error) {
    const errorText = error?.message || String(error);
    log?.("ai_error", { jid, identity: identityInfo.identity, sessionId: session.id, mode, error: errorText, text: prompt });
    console.error("[nera-ai]", errorText);
    const friendly = errorText.includes("403") ? "Nera API menolak request (403). Cek log ai_403 di console bot." : "Nera sedang bermasalah, coba lagi sebentar.";
    if (placeholder?.key) await sock.sendMessage(jid, { text: friendly, edit: placeholder.key }).catch(() => {});
    else await sock.sendMessage(jid, { text: friendly }, { quoted: message }).catch(() => {});
  } finally {
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
  }
}
