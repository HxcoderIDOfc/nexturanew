function getText(message) {
  return message?.message?.conversation
    || message?.message?.extendedTextMessage?.text
    || message?.message?.imageMessage?.caption
    || message?.message?.videoMessage?.caption
    || "";
}

export default async function nexturaAiPlugin({ sock, message }) {
  const jid = message?.key?.remoteJid;
  if (!jid || message?.key?.fromMe) return;

  const raw = String(getText(message)).trim();
  const match = raw.match(/^(?:\.ai|ai)\s+([\s\S]+)/i);
  if (!match) return;

  const apiKey = String(process.env.NEXTURA_AI_API_KEY || process.env.NEXTURA_API_KEY || "").trim();
  const baseUrl = String(process.env.NEXTURA_AI_BASE_URL || "https://nextura.my.id").replace(/\/+$/, "");
  const model = String(process.env.NEXTURA_AI_MODEL || "Nextura/cortexa-nexus2.7").trim();

  if (!apiKey) {
    await sock.sendMessage(jid, { text: "NEXTURA_AI_API_KEY belum disetel di environment." }, { quoted: message });
    return;
  }

  try {
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: match[1].trim() }],
        stream: false
      }),
      signal: AbortSignal.timeout(Number(process.env.NEXTURA_AI_TIMEOUT_MS || 120000))
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || data?.message || `HTTP ${response.status}`);

    const answer = data?.choices?.[0]?.message?.content || data?.message || "AI tidak mengembalikan jawaban.";
    await sock.sendMessage(jid, { text: String(answer) }, { quoted: message });
  } catch (error) {
    await sock.sendMessage(jid, { text: `AI error: ${error.message || String(error)}` }, { quoted: message });
  } finally {
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
  }
}
