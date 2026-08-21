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
const DEFAULT_MODE = String(process.env.NERA_AI_DEFAULT_MODE || "cepat").toLowerCase() === "pintar"
  ? "pintar"
  : "cepat";
const MAX_TURNS = Math.max(2, Number(process.env.NERA_AI_MEMORY_TURNS || 20));
const SESSION_DIR = path.resolve(process.env.WA_SESSION_DIR || "/tmp/nextura-wa-session");
const MEMORY_FILE = path.resolve(process.env.NERA_AI_MEMORY_FILE || path.join(SESSION_DIR, "nera-memory.json"));

function emptyStore() {
  return { version: 1, aliases: {}, sessions: {} };
}

function loadStore() {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    if (!fs.existsSync(MEMORY_FILE)) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    return {
      version: 1,
      aliases: parsed?.aliases && typeof parsed.aliases === "object" ? parsed.aliases : {},
      sessions: parsed?.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {}
    };
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

function normalizeJid(value = "") {
  return String(value || "").trim().toLowerCase();
}

function isLid(jid = "") {
  return normalizeJid(jid).endsWith("@lid");
}

function canonicalJid(jid = "") {
  const clean = normalizeJid(jid);
  return normalizeJid(store.aliases[clean] || clean);
}

function firstLid(values = []) {
  return values.map(normalizeJid).find(isLid) || "";
}

function firstJid(values = []) {
  return values.map(normalizeJid).find(Boolean) || "";
}

function getIdentity(message) {
  const key = message?.key || {};
  const remote = normalizeJid(key.remoteJid);
  const isGroup = remote.endsWith("@g.us");

  if (isGroup) {
    const participantCandidates = [
      key.participant,
      key.participantAlt,
      key.senderLid,
      key.senderPn,
      key.participantPn
    ];
    const participant = canonicalJid(firstLid(participantCandidates) || firstJid(participantCandidates) || "unknown");
    return {
      key: `group:${remote}|user:${participant}`,
      identity: participant,
      chatJid: remote,
      groupJid: remote,
      isGroup: true
    };
  }

  const directCandidates = [
    key.remoteJid,
    key.remoteJidAlt,
    key.senderLid,
    key.senderPn,
    key.participant,
    key.participantAlt
  ];
  const identity = canonicalJid(firstLid(directCandidates) || firstJid(directCandidates) || remote);
  return {
    key: `dm:${identity}`,
    identity,
    chatJid: remote || identity,
    groupJid: null,
    isGroup: false
  };
}

function newSession(identityInfo, mode = DEFAULT_MODE) {
  const now = Date.now();
  return {
    id: randomUUID(),
    identity: identityInfo.identity,
    chatJids: [...new Set([identityInfo.chatJid, identityInfo.identity].filter(Boolean))],
    groupJid: identityInfo.groupJid,
    mode,
    messages: [],
    createdAt: now,
    updatedAt: now
  };
}

function getSession(identityInfo) {
  let session = store.sessions[identityInfo.key];
  if (!session) {
    session = newSession(identityInfo);
    store.sessions[identityInfo.key] = session;
    saveStore();
  } else {
    session.chatJids = [...new Set([...(session.chatJids || []), identityInfo.chatJid, identityInfo.identity].filter(Boolean))];
    session.updatedAt = Date.now();
  }
  return session;
}

function trimMessages(messages = []) {
  return messages.slice(-(MAX_TURNS * 2));
}

function setChatMode(identityInfo, mode) {
  if (!VALID_MODES.has(mode)) return false;
  const session = getSession(identityInfo);
  session.mode = mode;
  session.updatedAt = Date.now();
  saveStore();
  return true;
}

function migrateAlias(pn, lid, log) {
  const cleanPn = normalizeJid(pn);
  const cleanLid = normalizeJid(lid);
  if (!cleanPn || !cleanLid || !isLid(cleanLid)) return;

  store.aliases[cleanPn] = cleanLid;
  store.aliases[cleanLid] = cleanLid;

  const oldDmKey = `dm:${cleanPn}`;
  const newDmKey = `dm:${cleanLid}`;
  if (store.sessions[oldDmKey]) {
    if (!store.sessions[newDmKey]) {
      store.sessions[newDmKey] = store.sessions[oldDmKey];
      store.sessions[newDmKey].identity = cleanLid;
      store.sessions[newDmKey].chatJids = [...new Set([...(store.sessions[newDmKey].chatJids || []), cleanPn, cleanLid])];
    } else {
      const oldSession = store.sessions[oldDmKey];
      const target = store.sessions[newDmKey];
      target.messages = trimMessages([...(oldSession.messages || []), ...(target.messages || [])]);
      target.chatJids = [...new Set([...(oldSession.chatJids || []), ...(target.chatJids || []), cleanPn, cleanLid])];
      target.updatedAt = Date.now();
    }
    delete store.sessions[oldDmKey];
  }

  for (const [key, session] of Object.entries(store.sessions)) {
    if (!key.includes(`|user:${cleanPn}`)) continue;
    const migratedKey = key.replace(`|user:${cleanPn}`, `|user:${cleanLid}`);
    if (!store.sessions[migratedKey]) {
      session.identity = cleanLid;
      session.chatJids = [...new Set([...(session.chatJids || []), cleanPn, cleanLid])];
      store.sessions[migratedKey] = session;
    }
    delete store.sessions[key];
  }

  saveStore();
  log?.("ai_lid_mapping", { pn: cleanPn, lid: cleanLid });
}

function resetSessionsForChat(jid, log) {
  const clean = normalizeJid(jid);
  const canonical = canonicalJid(clean);
  let removed = 0;

  for (const [key, session] of Object.entries(store.sessions)) {
    const chatJids = (session.chatJids || []).map(normalizeJid);
    const match = key === `dm:${clean}`
      || key === `dm:${canonical}`
      || session.groupJid === clean
      || chatJids.includes(clean)
      || chatJids.includes(canonical);

    if (match) {
      delete store.sessions[key];
      removed += 1;
    }
  }

  if (removed) saveStore();
  log?.("ai_memory_reset", { jid: clean, removed, reason: "chat_deleted" });
  return removed;
}

async function askNera(messages, mode, log, jid, sessionId) {
  const baseUrl = String(process.env.NERA_AI_BASE_URL || "https://api.axynera.my.id").replace(/\/+$/, "");
  const model = String(process.env.NERA_AI_MODEL || "Nera-Plus.5").trim() || "Nera-Plus.5";
  const apiKey = String(process.env.NERA_AI_API_KEY || "").trim();
  const timeoutMs = Number(process.env.NERA_AI_TIMEOUT_MS || 120000);

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  log?.("ai_request", {
    jid,
    sessionId,
    model,
    mode,
    historyMessages: Math.max(0, messages.length - 1),
    text: messages.at(-1)?.content || ""
  });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      mode,
      stream: false,
      messages
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || `Nera API ${response.status}`;
    throw new Error(detail);
  }

  const answer = String(data?.choices?.[0]?.message?.content || data?.message || "").trim();
  if (!answer) throw new Error("Nera tidak mengirim balasan.");

  log?.("ai_response", {
    jid,
    sessionId,
    model: data?.model || model,
    mode,
    text: answer
  });

  return answer;
}

export async function onLidMapping({ mapping, log }) {
  migrateAlias(mapping?.pn, mapping?.lid, log);
}

export async function onChatDelete({ jid, log }) {
  resetSessionsForChat(jid, log);
}

export async function onMessagesDelete({ event, log }) {
  if (event?.jid && event?.all === true) resetSessionsForChat(event.jid, log);
}

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
    const requestedMode = String(modeMatch[1] || "").toLowerCase();
    if (!requestedMode) {
      const currentMode = session.mode || DEFAULT_MODE;
      await sock.sendMessage(jid, {
        text:
          `⚙️ *Mode Nera saat ini: ${currentMode}*\n\n` +
          `Gunakan:\n` +
          `• *.mode cepat* — respons lebih cepat\n` +
          `• *.mode pintar* — penalaran lebih dalam`
      }, { quoted: message });
      return;
    }

    setChatMode(identityInfo, requestedMode);
    log?.("ai_mode", { jid, identity: identityInfo.identity, mode: requestedMode });
    await sock.sendMessage(jid, {
      text: requestedMode === "pintar"
        ? "🧠 Mode Nera diubah ke *pintar*."
        : "⚡ Mode Nera diubah ke *cepat*."
    }, { quoted: message });
    return;
  }

  if (/^\.(?:new|reset|newchat|lupain)\s*$/i.test(raw)) {
    delete store.sessions[identityInfo.key];
    const fresh = newSession(identityInfo, session.mode || DEFAULT_MODE);
    store.sessions[identityInfo.key] = fresh;
    saveStore();
    log?.("ai_memory_reset", { jid, sessionId: fresh.id, reason: "manual" });
    await sock.sendMessage(jid, { text: "🆕 Sesi Nera baru dibuat. Riwayat percakapan sebelumnya tidak dipakai lagi." }, { quoted: message });
    return;
  }

  const commandMatch = raw.match(/^(?:\.ai|ai)\s+([\s\S]+)/i);
  const autoReply = String(process.env.WA_AI_AUTO_REPLY || "true").toLowerCase() !== "false";
  if (!commandMatch && (!autoReply || lower === "ping" || raw.startsWith("."))) return;

  const prompt = commandMatch ? commandMatch[1].trim() : raw;
  if (!prompt) return;

  const mode = session.mode || DEFAULT_MODE;
  const messages = trimMessages([
    ...(session.messages || []),
    { role: "user", content: prompt }
  ]);

  try {
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    const answer = await askNera(messages, mode, log, jid, session.id);

    session.messages = trimMessages([
      ...messages,
      { role: "assistant", content: answer }
    ]);
    session.mode = mode;
    session.updatedAt = Date.now();
    session.chatJids = [...new Set([...(session.chatJids || []), jid, identityInfo.identity].filter(Boolean))];
    saveStore();

    await sock.sendMessage(jid, { text: answer }, { quoted: message });
  } catch (error) {
    const errorText = error?.message || String(error);
    log?.("ai_error", {
      jid,
      identity: identityInfo.identity,
      sessionId: session.id,
      mode,
      error: errorText,
      text: prompt
    });
    console.error("[nera-ai]", errorText);
    await sock.sendMessage(jid, { text: "Nera sedang bermasalah, coba lagi sebentar." }, { quoted: message }).catch(() => {});
  } finally {
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
  }
}
