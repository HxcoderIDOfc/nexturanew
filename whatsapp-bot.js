import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import { pushConsoleLog } from "./live-console.js";

const SESSION_DIR = path.resolve(process.env.WA_SESSION_DIR || "/tmp/nextura-wa-session");
const PLUGIN_DIR = path.resolve(process.env.WA_PLUGIN_DIR || "./wa-plugins");
const PLUGIN_RELOAD_MS = Number(process.env.WA_PLUGIN_RELOAD_MS || 5000);
const AUTO_READ = String(process.env.WA_AUTO_READ || "true").toLowerCase() !== "false";

const state = {
  status: "starting",
  qr: null,
  qrDataUrl: null,
  connectedAt: null,
  phone: null,
  pluginCount: 0,
  lastError: null,
  autoRead: AUTO_READ,
  updatedAt: Date.now()
};

let sock = null;
let pluginTimer = null;
let plugins = [];
let reconnectTimer = null;

function setState(patch = {}) {
  Object.assign(state, patch, { updatedAt: Date.now() });
}

function getText(message) {
  return message?.message?.conversation
    || message?.message?.extendedTextMessage?.text
    || message?.message?.imageMessage?.caption
    || message?.message?.videoMessage?.caption
    || message?.message?.documentMessage?.caption
    || "";
}

function jidLabel(jid = "") {
  return String(jid).replace(/@s\.whatsapp\.net$/i, "").replace(/@g\.us$/i, " [group]");
}

async function loadPlugins() {
  try {
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
    const files = fs.readdirSync(PLUGIN_DIR).filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
    const loaded = [];
    for (const file of files) {
      try {
        const full = path.join(PLUGIN_DIR, file);
        const stat = fs.statSync(full);
        const mod = await import(`${pathToFileURL(full).href}?v=${stat.mtimeMs}`);
        const handler = mod.default || mod.handler || mod.onMessage;
        if (typeof handler === "function") {
          loaded.push({
            name: file,
            handler,
            onChatDelete: typeof mod.onChatDelete === "function" ? mod.onChatDelete : null,
            onMessagesDelete: typeof mod.onMessagesDelete === "function" ? mod.onMessagesDelete : null,
            onLidMapping: typeof mod.onLidMapping === "function" ? mod.onLidMapping : null
          });
        }
      } catch (error) {
        console.error(`[wa-plugin] gagal load ${file}:`, error.message);
        pushConsoleLog("plugin_error", { plugin: file, error: error.message });
      }
    }
    plugins = loaded;
    setState({ pluginCount: loaded.length });
  } catch (error) {
    console.error("[wa-plugin] loader error:", error.message);
    pushConsoleLog("plugin_loader_error", { error: error.message });
  }
}

async function dispatchPlugins(message) {
  if (!sock || !message?.message) return;
  for (const plugin of plugins) {
    try {
      await plugin.handler({
        sock,
        message,
        state: getWhatsAppState,
        log: (type, payload = {}) => pushConsoleLog(type, { plugin: plugin.name, ...payload })
      });
    } catch (error) {
      console.error(`[wa-plugin] ${plugin.name} error:`, error.message);
      pushConsoleLog("plugin_error", { plugin: plugin.name, error: error.message });
    }
  }
}

async function dispatchPluginHook(hookName, payload = {}) {
  for (const plugin of plugins) {
    const hook = plugin?.[hookName];
    if (typeof hook !== "function") continue;
    try {
      await hook({
        sock,
        ...payload,
        state: getWhatsAppState,
        log: (type, data = {}) => pushConsoleLog(type, { plugin: plugin.name, ...data })
      });
    } catch (error) {
      console.error(`[wa-plugin] ${plugin.name} ${hookName} error:`, error.message);
      pushConsoleLog("plugin_hook_error", { plugin: plugin.name, hook: hookName, error: error.message });
    }
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void connectWhatsApp(), 3000);
}

async function connectWhatsApp() {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    await loadPlugins();
    if (!pluginTimer) pluginTimer = setInterval(() => void loadPlugins(), PLUGIN_RELOAD_MS).unref();

    const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      browser: ["Nextura WA", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages = [], type }) => {
      for (const message of messages) {
        if (!message?.message) continue;
        const jid = message?.key?.remoteJid || "";
        const text = String(getText(message)).trim();
        const fromMe = Boolean(message?.key?.fromMe);
        pushConsoleLog(fromMe ? "wa_out" : "wa_in", {
          jid,
          contact: jidLabel(jid),
          upsertType: type || null,
          text: text || `[${Object.keys(message.message || {})[0] || "message"}]`
        });

        // Hanya pesan live yang boleh memicu command/AI.
        // History sync/append tidak dibalas ulang.
        if (type !== "notify") continue;

        if (AUTO_READ && !fromMe && message?.key) {
          await sock.readMessages([message.key]).catch((error) => {
            pushConsoleLog("read_error", { jid, error: error.message });
          });
        }

        await dispatchPlugins(message);
      }
    });

    sock.ev.on("chats.delete", async (jids = []) => {
      for (const jid of jids) {
        pushConsoleLog("chat_delete", { jid, contact: jidLabel(jid) });
        await dispatchPluginHook("onChatDelete", { jid });
      }
    });

    sock.ev.on("messages.delete", async (event) => {
      await dispatchPluginHook("onMessagesDelete", { event });
    });

    sock.ev.on("lid-mapping.update", async (mapping) => {
      pushConsoleLog("lid_mapping", { pn: mapping?.pn || null, lid: mapping?.lid || null });
      await dispatchPluginHook("onLidMapping", { mapping });
    });

    sock.ev.on("messaging-history.set", async ({ lidPnMappings = [] }) => {
      for (const mapping of lidPnMappings || []) {
        await dispatchPluginHook("onLidMapping", { mapping });
      }
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        let qrDataUrl = null;
        try { qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 340 }); } catch {}
        setState({ status: "qr", qr, qrDataUrl, lastError: null });
        pushConsoleLog("connection", { status: "qr", text: "QR WhatsApp siap dipindai" });
      }
      if (connection === "open") {
        const id = sock?.user?.id || "";
        setState({
          status: "connected",
          qr: null,
          qrDataUrl: null,
          connectedAt: Date.now(),
          phone: id.split(":")[0] || null,
          lastError: null
        });
        pushConsoleLog("connection", { status: "connected", text: "WhatsApp terhubung" });
      }
      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        setState({
          status: loggedOut ? "logged_out" : "disconnected",
          qr: null,
          qrDataUrl: null,
          lastError: lastDisconnect?.error?.message || null
        });
        pushConsoleLog("connection", {
          status: loggedOut ? "logged_out" : "disconnected",
          text: lastDisconnect?.error?.message || "Koneksi WhatsApp terputus"
        });
        if (!loggedOut) scheduleReconnect();
      }
    });
  } catch (error) {
    setState({ status: "error", lastError: error.message || String(error) });
    pushConsoleLog("connection_error", { error: error.message || String(error) });
    scheduleReconnect();
  }
}

export function getWhatsAppState() {
  return { ...state, pluginDir: PLUGIN_DIR, sessionDir: SESSION_DIR };
}

export async function restartWhatsApp() {
  try { sock?.end?.(new Error("manual restart")); } catch {}
  sock = null;
  setState({ status: "restarting", qr: null, qrDataUrl: null });
  pushConsoleLog("connection", { status: "restarting", text: "Restart koneksi manual" });
  await connectWhatsApp();
  return getWhatsAppState();
}

export async function logoutWhatsApp() {
  try { await sock?.logout?.(); } catch {}
  try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
  sock = null;
  setState({ status: "logged_out", qr: null, qrDataUrl: null, phone: null, connectedAt: null });
  pushConsoleLog("connection", { status: "logged_out", text: "Session WhatsApp dihapus" });
  scheduleReconnect();
  return getWhatsAppState();
}

void connectWhatsApp();
