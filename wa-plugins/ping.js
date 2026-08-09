export default async function pingPlugin({ sock, message }) {
  const jid = message?.key?.remoteJid;
  if (!jid || message?.key?.fromMe) return;
  const text = message?.message?.conversation || message?.message?.extendedTextMessage?.text || "";
  if (String(text).trim().toLowerCase() !== "ping") return;
  await sock.sendMessage(jid, { text: "pong 🟢 Nextura WA aktif" }, { quoted: message });
}
