export default async function neraDiagnosticPlugin({ sock, message, log }) {
  const jid = message?.key?.remoteJid;
  if (!jid || message?.key?.fromMe || jid === "status@broadcast") return;

  const text = String(
    message?.message?.conversation ||
    message?.message?.extendedTextMessage?.text ||
    ""
  ).trim().toLowerCase();

  if (![".neradiag", ".diagnosa", ".diagnosa-nera"].includes(text)) return;

  const baseUrl = String(process.env.NERA_AI_BASE_URL || "https://api.axynera.my.id").replace(/\/+$/, "");
  const apiKey = String(process.env.NERA_AI_API_KEY || "").trim();

  await sock.sendMessage(jid, {
    text: "🔍 Menjalankan diagnostik Nera API…"
  }, { quoted: message }).catch(() => {});

  try {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "Axynera-WA-Bot/1.0"
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "Nera-Plus.5",
        mode: "cepat",
        stream: false,
        messages: [
          { role: "user", content: "Tes Nera" }
        ]
      }),
      signal: AbortSignal.timeout(Number(process.env.NERA_AI_TIMEOUT_MS || 120000))
    });

    const body = await res.text();
    const result = {
      status: res.status,
      server: res.headers.get("server"),
      cfRay: res.headers.get("cf-ray"),
      contentType: res.headers.get("content-type"),
      body: body.slice(0, 1500)
    };

    console.log("\n===== NERA API DIAGNOSTIC =====");
    console.log("STATUS:", result.status);
    console.log("SERVER:", result.server);
    console.log("CF-RAY:", result.cfRay);
    console.log("CONTENT-TYPE:", result.contentType);
    console.log("BODY:", result.body);
    console.log("===== END NERA DIAGNOSTIC =====\n");

    log?.("nera_diagnostic", {
      jid,
      status: result.status,
      server: result.server,
      cfRay: result.cfRay,
      contentType: result.contentType,
      body: result.body
    });

    await sock.sendMessage(jid, {
      text:
        `🔍 *Nera Diagnostic*\n\n` +
        `STATUS: ${result.status}\n` +
        `SERVER: ${result.server || "-"}\n` +
        `CF-RAY: ${result.cfRay || "-"}\n` +
        `CONTENT-TYPE: ${result.contentType || "-"}\n\n` +
        `BODY awal:\n${result.body.slice(0, 700)}`
    }, { quoted: message }).catch(() => {});
  } catch (error) {
    const err = error?.message || String(error);
    console.error("[nera-diagnostic]", err);
    log?.("nera_diagnostic_error", { jid, error: err });
    await sock.sendMessage(jid, {
      text: `❌ Diagnostik gagal: ${err}`
    }, { quoted: message }).catch(() => {});
  }
}
