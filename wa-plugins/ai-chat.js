import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

function getText(m) {
  return (
    m?.message?.conversation ||
    m?.message?.extendedTextMessage?.text ||
    m?.message?.imageMessage?.caption ||
    m?.message?.videoMessage?.caption ||
    ""
  );
}

const MAX_TURNS = Math.max(2, Number(process.env.AXYNITY_MEMORY_TURNS || 20));
const STREAM_EDIT_MS = Math.max(700, Number(process.env.AXYNITY_STREAM_EDIT_MS || 1200));
const THINK_ANIMATION_MS = Math.max(700, Number(process.env.AXYNITY_THINK_ANIMATION_MS || 900));
const MAX_IMAGE_BYTES = Math.max(256000, Number(process.env.AXYNITY_MAX_IMAGE_BYTES || 8 * 1024 * 1024));
const SESSION_DIR = path.resolve(process.env.WA_SESSION_DIR || "/tmp/axynera-wa-session");
const MEMORY_FILE = path.resolve(process.env.AXYNITY_MEMORY_FILE || path.join(SESSION_DIR, "axynity-memory.json"));

const TEXT_TIMEOUT_MS = Number(process.env.AXYNITY_TIMEOUT_MS || 120000);
const IMAGE_TIMEOUT_MS = Number(process.env.AXYNITY_IMAGE_TIMEOUT_MS || 180000);

const AXYNITY_API_KEY = String(process.env.AXYNITY_API_KEY || "").trim();
if (!AXYNITY_API_KEY) {
  console.error("[axynity-plugin] FATAL: AXYNITY_API_KEY belum di-set di environment.");
}

function emptyStore() { return { version: 1, aliases: {}, sessions: {} }; }
function loadStore() {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    if (!fs.existsSync(MEMORY_FILE)) return emptyStore();
    const x = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    return { version: 1, aliases: x?.aliases || {}, sessions: x?.sessions || {} };
  } catch (e) {
    console.error("[axynity-memory] gagal membaca:", e.message);
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
  } catch (e) { console.error("[axynity-memory] gagal menyimpan:", e.message); }
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

function newSession(info) {
  const now = Date.now();
  return { id: randomUUID(), identity: info.identity, chatJids: [...new Set([info.chatJid, info.identity].filter(Boolean))], groupJid: info.groupJid, messages: [], createdAt: now, updatedAt: now };
}
function getSession(info) {
  if (!store.sessions[info.key]) { store.sessions[info.key] = newSession(info); saveStore(); }
  return store.sessions[info.key];
}
const trimMessages = (m = []) => m.slice(-(MAX_TURNS * 2));
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
  t = t.replace(/<(?:minimax:)?(?:think|reasoning|analysis)\b[^>]*>[\s\S]*?(?:<\/(?:minimax:)?(?:think|reasoning|analysis)>|$)/gi, "");
  t = t.replace(/<\/?(?:minimax:)?(?:think|reasoning|analysis)\b[^>]*>/gi, "");
  return t.trim();
}

async function convertImageToWebp(buffer) {
  try {
    const sharp = (await import("sharp")).default;
    return await sharp(buffer)
      .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    try {
      return await new Promise((resolve, reject) => {
        const ff = spawn("ffmpeg", [
          "-i", "pipe:0",
          "-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
          "-f", "webp",
          "pipe:1"
        ]);
        const chunks = [];
        ff.stdout.on("data", (chunk) => chunks.push(chunk));
        ff.on("close", (code) => {
          if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
          else reject(new Error("FFmpeg error"));
        });
        ff.on("error", reject);
        ff.stdin.write(buffer);
        ff.stdin.end();
      });
    } catch {
      return buffer;
    }
  }
}

async function downloadWhatsAppMedia(targetMsg, mediaType = "buffer") {
  try {
    let downloadMediaMessage;
    try {
      const baileys = await import("@whiskeysockets/baileys");
      downloadMediaMessage = baileys.downloadMediaMessage;
    } catch {
      const baileys = await import("@adiwajshing/baileys");
      downloadMediaMessage = baileys.downloadMediaMessage;
    }
    return await downloadMediaMessage(targetMsg, mediaType, {});
  } catch (err) {
    throw new Error(`Gagal mengunduh media WhatsApp: ${err.message}`);
  }
}

async function downloadWhatsAppImage(message, media) {
  if (media?.path && fs.existsSync(media.path)) {
    const stat = fs.statSync(media.path);
    if (stat.size > MAX_IMAGE_BYTES) throw new Error(`Gambar terlalu besar (${Math.ceil(stat.size / 1024 / 1024)} MB). Maksimal ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`);
    return fs.readFileSync(media.path).toString("base64");
  }

  if (Buffer.isBuffer(media?.buffer)) {
    if (media.buffer.length > MAX_IMAGE_BYTES) throw new Error(`Gambar terlalu besar. Maksimal ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`);
    return media.buffer.toString("base64");
  }

  const isDirectImage = Boolean(message?.message?.imageMessage);
  const isQuotedImage = Boolean(message?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage);

  if (isDirectImage || isQuotedImage) {
    let targetMsg = message;
    if (isQuotedImage) {
      const ctx = message.message.extendedTextMessage.contextInfo;
      targetMsg = {
        key: {
          remoteJid: message.key.remoteJid,
          id: ctx.stanzaId,
          participant: ctx.participant
        },
        message: ctx.quotedMessage
      };
    }
    const buffer = await downloadWhatsAppMedia(targetMsg, "buffer");
    if (buffer) {
      if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Ukuran gambar melebihi batas maksimum.");
      return buffer.toString("base64");
    }
  }

  return null;
}

async function buildUserContent(prompt, message, media) {
  const text = String(prompt || "").trim() || "Jelaskan gambar ini.";
  const b64Image = await downloadWhatsAppImage(message, media);

  if (!b64Image) return text;

  const mimetype = media?.mimetype || message?.message?.imageMessage?.mimetype || "image/jpeg";
  return [
    { type: "text", text },
    { type: "image_url", image_url: { url: `data:${mimetype};base64,${b64Image}` } }
  ];
}

function headers(apiKey, stream) {
  const h = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "User-Agent": "Axynity-WA-Bot/1.0"
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
    const e = new Error(`Axynity gateway sedang bermasalah (HTTP ${status}).`); e.code = "AXYNITY_GATEWAY_HTML"; e.status = status; return e;
  }
  try {
    const d = JSON.parse(body || "{}");
    const msg = d?.error?.message || d?.message;
    if (msg) { const e = new Error(String(msg)); e.status = status; return e; }
  } catch {}
  const e = new Error(`Axynity API HTTP ${status}.`); e.status = status; return e;
}
async function doAxynityRequest({ baseUrl, model, messages, apiKey, timeoutMs, stream = true, includeModel = true }) {
  const payload = { stream, messages };
  if (includeModel && model) payload.model = model;
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: headers(apiKey, stream),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
}
async function parseNonStreamResponse(r, { log, jid, sessionId, model }) {
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
  catch { throw new Error("Axynity non-stream mengirim JSON tidak valid."); }
  const answer = stripHiddenReasoning(data?.choices?.[0]?.message?.content || data?.message?.content || data?.text || "");
  if (!answer) throw new Error("Axynity non-stream tidak mengirim jawaban.");
  log?.("ai_response", { jid, sessionId, model, stream: false, text: answer });
  return answer;
}

async function askAxynityStream({ messages, log, jid, sessionId, hasImage, onVisibleText, onThinking }) {
  const baseUrl = String(process.env.AXYNITY_BASE_URL || process.env.NERA_AI_BASE_URL || "http://170.39.194.189:4123").replace(/\/+$/, "");
  const model = String(process.env.AXYNITY_MODEL || process.env.NERA_AI_MODEL || "axynity").trim() || "axynity";

  if (!AXYNITY_API_KEY) {
    throw new Error("AXYNITY_API_KEY belum di-set di environment.");
  }

  const timeoutMs = hasImage ? IMAGE_TIMEOUT_MS : TEXT_TIMEOUT_MS;
  log?.("ai_request", { jid, sessionId, model, stream: true, hasImage, timeoutMs, historyMessages: Math.max(0, messages.length - 1) });

  let r = await doAxynityRequest({ baseUrl, model, messages, apiKey: AXYNITY_API_KEY, timeoutMs, stream: true, includeModel: true });
  if (r.status === 403) {
    const b = await r.text().catch(() => "");
    log?.("ai_403", { jid, sessionId, withModel: true, contentType: r.headers.get("content-type") || "", body: b.slice(0, 1200) });
    r = await doAxynityRequest({ baseUrl, model, messages, apiKey: AXYNITY_API_KEY, timeoutMs, stream: true, includeModel: false });
  }

  if (!r.ok || (r.headers.get("content-type") || "").toLowerCase().includes("text/html")) {
    const b = await r.text().catch(() => "");
    const ct = r.headers.get("content-type") || "";
    log?.("ai_stream_fallback", { jid, sessionId, status: r.status, contentType: ct, html: isHtml(b, ct), body: b.slice(0, 1600) });

    let fallback = await doAxynityRequest({ baseUrl, model, messages, apiKey: AXYNITY_API_KEY, timeoutMs, stream: false, includeModel: true });
    if (fallback.status === 403) {
      const fb = await fallback.text().catch(() => "");
      log?.("ai_nonstream_403", { jid, sessionId, withModel: true, body: fb.slice(0, 1200) });
      fallback = await doAxynityRequest({ baseUrl, model, messages, apiKey: AXYNITY_API_KEY, timeoutMs, stream: false, includeModel: false });
    }
    const answer = await parseNonStreamResponse(fallback, { log, jid, sessionId, model });
    onVisibleText?.(answer);
    return answer;
  }

  if (!r.body) throw new Error("Axynity SSE tidak mengirim response body.");
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
  if (!answer) throw new Error("Axynity tidak mengirim balasan yang bisa ditampilkan.");
  log?.("ai_response", { jid, sessionId, model, stream: true, text: answer });
  return answer;
}

export async function onLidMapping({ mapping, log }) { migrateAlias(mapping?.pn, mapping?.lid, log); }
export async function onChatDelete({ jid, log }) { resetSessionsForChat(jid, log); }
export async function onMessagesDelete({ event, log }) { if (event?.jid && event?.all === true) resetSessionsForChat(event.jid, log); }

export default async function axynityPlugin({ sock, message, media, log }) {
  const jid = message?.key?.remoteJid;
  if (!jid || message?.key?.fromMe || jid === "status@broadcast") return;
  const raw = String(getText(message)).trim();

  const hasDirectImage = Boolean(message?.message?.imageMessage);
  const hasQuotedImage = Boolean(message?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage);
  const hasImage = hasDirectImage || hasQuotedImage || media?.type === "image";
  const hasSticker = Boolean(message?.message?.stickerMessage);

  // 1. FITUR KOMENTAR STIKER SPONTAN KETIKA ORANG KIRIM STIKER TIBA-TIBA
  if (hasSticker) {
    try {
      const emojis = ["😂", "🔥", "👍", "🗿", "💀", "❤️", "✨"];
      const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
      await sock.sendMessage(jid, { react: { text: randomEmoji, key: message.key } }).catch(() => {});

      const stickerBuffer = await downloadWhatsAppMedia(message, "buffer");
      if (stickerBuffer) {
        const b64Sticker = stickerBuffer.toString("base64");
        const stickerContent = [
          { type: "text", text: "User mengirim stiker ini secara tiba-tiba di chat. Berikan komentar santai 1 kalimat penuh antusias seperti: 'Wihh stickernya bagus/lucu banget, gambar [deskripsikan objek/karakter/hal menarik di stiker]...' Sampaikan secara alami layaknya teman di WhatsApp." },
          { type: "image_url", image_url: { url: `data:image/webp;base64,${b64Sticker}` } }
        ];
        const commentMessages = [{ role: "user", content: stickerContent }];
        const comment = await askAxynityStream({ messages: commentMessages, log, jid, sessionId: "sticker-comment", hasImage: true });
        if (comment) {
          await sock.sendMessage(jid, { text: comment }, { quoted: message });
        }
      }
    } catch (e) {
      log?.("sticker_comment_error", { error: e.message });
    }
    return;
  }

  if (!raw && !hasImage) return;

  const lower = raw.toLowerCase(); const info = getIdentity(message); const session = getSession(info);
  
  if (!hasImage && /^\.(?:new|reset|newchat|lupain)\s*$/i.test(raw)) {
    delete store.sessions[info.key]; store.sessions[info.key] = newSession(info); saveStore();
    await sock.sendMessage(jid, { text: "🆕 Sesi Axynity baru dibuat." }, { quoted: message }); return;
  }

  const cmd = raw.match(/^(?:\.ai|ai)\s+([\s\S]+)/i);
  const autoReply = String(process.env.WA_AI_AUTO_REPLY || "true").toLowerCase() !== "false";

  // 2. FITUR UBAH GAMBAR KE STIKER + AI DETEKSI ISI GAMBAR DAN BERI PESAN TERTULIS
  const isStickerCommand = hasImage && /\b(sticker|stiker)\b/i.test(raw);
  if (isStickerCommand) {
    let placeholder = null;
    try {
      placeholder = await sock.sendMessage(jid, { text: "⏳ Sedang membuat stiker..." }, { quoted: message }).catch(() => null);

      let targetMsg = message;
      if (hasQuotedImage) {
        const ctx = message.message.extendedTextMessage.contextInfo;
        targetMsg = {
          key: { remoteJid: message.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant },
          message: ctx.quotedMessage
        };
      }
      
      let imgBuffer = await downloadWhatsAppMedia(targetMsg, "buffer");
      if (!imgBuffer && media?.path && fs.existsSync(media.path)) {
        imgBuffer = fs.readFileSync(media.path);
      }
      if (!imgBuffer && Buffer.isBuffer(media?.buffer)) {
        imgBuffer = media.buffer;
      }

      if (imgBuffer) {
        const webpBuffer = await convertImageToWebp(imgBuffer);

        // Hapus pesan placeholder teks agar tidak menumpuk
        if (placeholder?.key) {
          await sock.sendMessage(jid, { delete: placeholder.key }).catch(() => {});
        }

        // Kirim stiker terlebih dahulu
        const sentSticker = await sock.sendMessage(jid, { sticker: webpBuffer }, { quoted: message });
        await sock.sendMessage(jid, { react: { text: "🔥", key: message.key } }).catch(() => {});

        // AI Vision mendeteksi objek gambar lalu beri respon balasan khusus
        const b64Image = imgBuffer.toString("base64");
        const promptContent = [
          { type: "text", text: "Stiker dari gambar ini baru saja berhasil dibuat. Berikan pesan santai 1 kalimat sederhana untuk memberi tahu user, contohnya: 'Stickernya udah jadi nih! Gambar [sebutkan objek/hewan/ekspresi di gambar]...' " },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64Image}` } }
        ];

        const aiResponse = await askAxynityStream({
          messages: [{ role: "user", content: promptContent }],
          log,
          jid,
          sessionId: "sticker-make-comment",
          hasImage: true
        });

        if (aiResponse) {
          await sock.sendMessage(jid, { text: aiResponse }, { quoted: sentSticker || message });
        }
        return;
      } else {
        throw new Error("Buffer gambar kosong atau gagal diunduh.");
      }
    } catch (e) {
      const errText = `❌ Gagal membuat stiker: ${e.message}`;
      if (placeholder?.key) {
        await sock.sendMessage(jid, { text: errText, edit: placeholder.key }).catch(() => {});
      } else {
        await sock.sendMessage(jid, { text: errText }, { quoted: message }).catch(() => {});
      }
      return;
    }
  }

  if (!hasImage && !cmd && (!autoReply || lower === "ping" || raw.startsWith("."))) return;
  if (hasImage && !cmd && !raw && !autoReply) return;

  if (/\b(terima kasih|makasih|thanks|thx)\b/i.test(lower)) {
    await sock.sendMessage(jid, { react: { text: "❤️", key: message.key } }).catch(() => {});
  } else if (/\b(keren|mantap|good|hebat|pro)\b/i.test(lower)) {
    await sock.sendMessage(jid, { react: { text: "🔥", key: message.key } }).catch(() => {});
  } else if (/\b(wkwk|hahaha|lol|lucu)\b/i.test(lower)) {
    await sock.sendMessage(jid, { react: { text: "😂", key: message.key } }).catch(() => {});
  }

  const prompt = cmd ? cmd[1].trim() : (raw || "Jelaskan gambar ini.");

  let userContent;
  try {
    userContent = await buildUserContent(prompt, message, media);
  } catch (e) {
    await sock.sendMessage(jid, { text: e.message }, { quoted: message }).catch(() => {});
    return;
  }

  const messages = trimMessages([...(session.messages || []).map(m => ({ role: m.role, content: m.content })), { role: "user", content: userContent }]);
  let placeholder = null, lastEditAt = 0, lastRendered = "", visibleStarted = false, frame = 0, timer = null;
  const stopAnim = () => { if (timer) clearInterval(timer); timer = null; };

  let socketAlive = true;
  const safeSend = async (payload) => {
    if (!socketAlive) return false;
    try {
      await sock.sendMessage(jid, payload, payload.edit ? undefined : { quoted: message });
      return true;
    } catch (e) {
      const msg = String(e?.message || e);
      if (/connection closed|not connected|timed out|stream errored/i.test(msg)) socketAlive = false;
      log?.("ai_send_error", { jid, error: msg });
      return false;
    }
  };

  try {
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    const base = hasImage ? "🖼️ Axynity sedang melihat gambar" : "🧠 Axynity sedang berpikir";
    placeholder = await sock.sendMessage(jid, { text: `${base}...` }, { quoted: message }).catch((e) => {
      log?.("ai_placeholder_error", { jid, error: e?.message });
      return null;
    });
    timer = setInterval(() => {
      if (!placeholder?.key || visibleStarted || !socketAlive) return;
      frame = (frame + 1) % 3;
      void sock.sendMessage(jid, { text: `${base}${".".repeat(frame + 1)}`, edit: placeholder.key }).catch((e) => {
        const msg = String(e?.message || e);
        if (/connection closed|not connected|timed out|stream errored/i.test(msg)) socketAlive = false;
      });
    }, THINK_ANIMATION_MS); timer.unref?.();

    const render = async (text, force = false) => {
      const clean = stripHiddenReasoning(text); if (!clean || clean === lastRendered) return true;
      visibleStarted = true; stopAnim();
      if (!force && Date.now() - lastEditAt < STREAM_EDIT_MS) return true;
      lastEditAt = Date.now(); lastRendered = clean;
      if (placeholder?.key) {
        const ok = await safeSend({ text: clean, edit: placeholder.key });
        if (ok) return true;
      }
      return safeSend({ text: clean });
    };

    const answer = await askAxynityStream({ messages, log, jid, sessionId: session.id, hasImage, onVisibleText: v => void render(v), onThinking: () => {} });
    const rendered = await render(answer, true);
    if (!rendered) throw new Error("Jawaban Axynity diterima, tetapi gagal dikirim ke WhatsApp (koneksi mungkin terputus).");

    session.messages = trimMessages([...(session.messages || []), { role: "user", content: Array.isArray(userContent) ? `[Gambar] ${prompt}` : prompt }, { role: "assistant", content: answer }]);
    session.updatedAt = Date.now(); session.chatJids = [...new Set([...(session.chatJids || []), jid, info.identity].filter(Boolean))]; saveStore();
  } catch (e) {
    stopAnim();
    const err = e?.message || String(e);
    log?.("ai_error", { jid, identity: info.identity, sessionId: session.id, status: e?.status || null, code: e?.code || null, error: err, text: prompt, hasImage });
    console.error("[axynity-plugin]", err);
    let friendly = "Axynity sedang bermasalah, coba lagi sebentar.";
    if (e?.code === "AXYNITY_GATEWAY_HTML") friendly = `Axynity gateway sedang bermasalah (HTTP ${e.status || "?"}). Coba lagi sebentar.`;
    else if (e?.status === 403 || err.includes("403")) friendly = "Axynity API menolak request (403). Cek konfigurasi API/Cloudflare.";
    else if (!AXYNITY_API_KEY) friendly = "Bot belum dikonfigurasi dengan benar (API key kosong). Hubungi admin.";
    else if (/timed out|abort/i.test(err)) friendly = hasImage ? "Analisis gambar terlalu lama, coba kirim ulang atau gambar lebih kecil." : "Axynity terlalu lama merespons, coba lagi.";

    let sent = false;
    if (placeholder?.key && socketAlive) {
      sent = await safeSend({ text: friendly, edit: placeholder.key });
    }
    if (!sent && socketAlive) await safeSend({ text: friendly });
  } finally {
    stopAnim(); await sock.sendPresenceUpdate("paused", jid).catch(() => {});
  }
}
