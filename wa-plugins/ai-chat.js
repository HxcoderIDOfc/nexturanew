function getText(message) {
  return message?.message?.conversation
    || message?.message?.extendedTextMessage?.text
    || message?.message?.imageMessage?.caption
    || message?.message?.videoMessage?.caption
    || "";
}

const chatModes = new Map();
const VALID_MODES = new Set(["cepat", "pintar"]);
const DEFAULT_MODE = String(process.env.NERA_AI_DEFAULT_MODE || "cepat").toLowerCase() === "pintar"
  ? "pintar"
  : "cepat";

function getChatMode(jid) {
  return chatModes.get(jid) || DEFAULT_MODE;
}

function setChatMode(jid, mode) {
  if (!VALID_MODES.has(mode)) return false;
  chatModes.set(jid, mode);
  return true;
}

async function askNera(text, mode, log, jid) {
  const baseUrl = String(
    process.env.NERA_AI_BASE_URL || "https://api.axynera.my.id"
  ).replace(/\/+$/, "");

  const model = String(process.env.NERA_AI_MODEL || "Nera-Plus.5").trim() || "Nera-Plus.5";
  const apiKey = String(process.env.NERA_AI_API_KEY || "").trim();
  const timeoutMs = Number(process.env.NERA_AI_TIMEOUT_MS || 120000);

  const headers = {
    "Content-Type": "application/json"
  };

  // Opsional: endpoint Axynera saat ini bisa dipakai tanpa key.
  // Kalau nanti API key diaktifkan, cukup isi NERA_AI_API_KEY di environment.
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  log?.("ai_request", {
    jid,
    model,
    mode,
    text
  });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      mode,
      stream: false,
      messages: [
        {
          role: "user",
          content: text
        }
      ]
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = data?.error?.message || data?.message || `Nera API ${response.status}`;
    throw new Error(detail);
  }

  const answer = String(
    data?.choices?.[0]?.message?.content ||
    data?.message ||
    ""
  ).trim();

  if (!answer) {
    throw new Error("Nera tidak mengirim balasan.");
  }

  log?.("ai_response", {
    jid,
    model: data?.model || model,
    mode,
    text: answer
  });

  return answer;
}

export default async function neraAiPlugin({ sock, message, log }) {
  const jid = message?.key?.remoteJid;
  if (!jid || message?.key?.fromMe || jid === "status@broadcast") return;

  const raw = String(getText(message)).trim();
  if (!raw) return;

  const lower = raw.toLowerCase();

  // Pilih mode AI per chat.
  // Contoh: .mode cepat | .mode pintar | .mode
  const modeMatch = raw.match(/^\.?(?:mode|nera\s+mode)(?:\s+(cepat|pintar))?\s*$/i);
  if (modeMatch) {
    const requestedMode = String(modeMatch[1] || "").toLowerCase();

    if (!requestedMode) {
      const currentMode = getChatMode(jid);
      await sock.sendMessage(
        jid,
        {
          text:
            `⚙️ *Mode Nera saat ini: ${currentMode}*\n\n` +
            `Gunakan:\n` +
            `• *.mode cepat* — respons lebih cepat\n` +
            `• *.mode pintar* — penalaran lebih dalam`
        },
        { quoted: message }
      );
      return;
    }

    setChatMode(jid, requestedMode);
    log?.("ai_mode", { jid, mode: requestedMode });

    await sock.sendMessage(
      jid,
      {
        text:
          requestedMode === "pintar"
            ? "🧠 Mode Nera diubah ke *pintar*."
            : "⚡ Mode Nera diubah ke *cepat*."
      },
      { quoted: message }
    );
    return;
  }

  const commandMatch = raw.match(/^(?:\.ai|ai)\s+([\s\S]+)/i);
  const autoReply = String(process.env.WA_AI_AUTO_REPLY || "true").toLowerCase() !== "false";

  // Jangan berebut dengan plugin command lain.
  if (!commandMatch && (!autoReply || lower === "ping" || raw.startsWith("."))) return;

  const prompt = commandMatch ? commandMatch[1].trim() : raw;
  if (!prompt) return;

  const mode = getChatMode(jid);

  try {
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});

    const answer = await askNera(prompt, mode, log, jid);

    await sock.sendMessage(
      jid,
      { text: answer },
      { quoted: message }
    );
  } catch (error) {
    const errorText = error?.message || String(error);
    log?.("ai_error", {
      jid,
      mode,
      error: errorText,
      text: prompt
    });

    console.error("[nera-ai]", errorText);

    await sock.sendMessage(
      jid,
      { text: "Nera sedang bermasalah, coba lagi sebentar." },
      { quoted: message }
    ).catch(() => {});
  } finally {
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
  }
}
