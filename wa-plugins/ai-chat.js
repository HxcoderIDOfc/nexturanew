function getText(message) {
  return message?.message?.conversation
    || message?.message?.extendedTextMessage?.text
    || message?.message?.imageMessage?.caption
    || message?.message?.videoMessage?.caption
    || "";
}

let cachedModel = "";
let cachedAt = 0;

async function resolveModel(baseUrl, apiKey, log) {
  const configured = String(process.env.NEXTURA_AI_MODEL || "").trim();
  if (configured) return configured;
  if (cachedModel && Date.now() - cachedAt < 10 * 60 * 1000) return cachedModel;

  const response = await fetch(`${baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(Number(process.env.NEXTURA_AI_TIMEOUT_MS || 120000))
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `Gagal membaca model: HTTP ${response.status}`);
  const models = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const model = String(models[0]?.id || models[0]?.name || "").trim();
  if (!model) throw new Error("API Nextura tidak mengembalikan model yang bisa dipakai.");
  cachedModel = model;
  cachedAt = Date.now();
  log?.("ai_model", { model, text: `Model otomatis: ${model}` });
  return model;
}

export default async function nexturaAiPlugin({ sock, message, log }) {
  const jid = message?.key?.remoteJid;
  if (!jid || message?.key?.fromMe) return;

  const raw = String(getText(message)).trim();
  const match = raw.match(/^(?:\.ai|ai)\s+([\s\S]+)/i);
  if (!match) return;

  const prompt = match[1].trim();
  const apiKey = String(process.env.NEXTURA_AI_API_KEY || process.env.NEXTURA_API_KEY || "").trim();
  const baseUrl = String(process.env.NEXTURA_AI_BASE_URL || "https://api.nextura.my.id").replace(/\/+$/, "");

  if (!apiKey) {
    const text = "NEXTURA_AI_API_KEY belum disetel di environment.";
    log?.("ai_error", { jid, error: text });
    await sock.sendMessage(jid, { text }, { quoted: message });
    return;
  }

  try {
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    const model = await resolveModel(baseUrl, apiKey, log);
    log?.("ai_request", { jid, model, text: prompt });

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false
      }),
      signal: AbortSignal.timeout(Number(process.env.NEXTURA_AI_TIMEOUT_MS || 120000))
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || data?.message || `HTTP ${response.status}`);

    const answer = String(data?.choices?.[0]?.message?.content || data?.message || "AI tidak mengembalikan jawaban.");
    log?.("ai_response", { jid, model: data?.model || model, text: answer });
    await sock.sendMessage(jid, { text: answer }, { quoted: message });
  } catch (error) {
    const errorText = error.message || String(error);
    log?.("ai_error", { jid, error: errorText });
    await sock.sendMessage(jid, { text: `AI error: ${errorText}` }, { quoted: message });
  } finally {
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
  }
}
