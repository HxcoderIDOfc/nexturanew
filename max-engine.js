const COMPLEX_HINTS = /\b(analisis|analyze|bandingkan|compare|debug|perbaiki|fix|arsitektur|architecture|algoritma|algorithm|reasoning|matematika|math|hitung|derive|proof|buktikan|rencana|strategy|strategi|review|audit|security|keamanan|optimasi|optimize|refactor|implementasi|implementation|coding|kode|code|javascript|typescript|python|sql|api|sdk|bug|error|edge case|production|benchmark)\b/i;
const FRESH_HINTS = /\b(hari ini|today|terbaru|latest|sekarang|current|baru saja|recent|minggu ini|bulan ini|harga sekarang|status sekarang|berita|news|rilis terbaru|versi terbaru)\b/i;
const PRECISION_HINTS = /\b(tepat|akurat|jangan mengarang|jangan salah|verifikasi|verify|cek ulang|pastikan|faktual|factual|legal|hukum|keuangan|financial|medis|medical)\b/i;

function userText(messages = []) {
  const m = [...messages].reverse().find((x) => x?.role === "user");
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content.filter((p) => p?.type === "text" || p?.type === "input_text").map((p) => p.text || "").join("\n");
}

export function classifyMaxTask(messages = [], body = {}) {
  const text = userText(messages);
  const chars = text.length;
  const codeLike = /```|\b(function|const|let|class|import|export|SELECT|CREATE TABLE|curl|npm|node)\b/i.test(text);
  let score = 0;
  if (COMPLEX_HINTS.test(text)) score += 2;
  if (PRECISION_HINTS.test(text)) score += 2;
  if (codeLike) score += 2;
  if (chars > 1200) score += 2;
  else if (chars > 500) score += 1;
  if ((text.match(/[?]/g) || []).length >= 3) score += 1;
  if (/\b(langkah demi langkah|step by step|multi[- ]?step|end-to-end|lengkap|mendalam|deep)\b/i.test(text)) score += 2;

  const tier = score >= 6 ? "expert" : score >= 3 ? "advanced" : "standard";
  const fresh = FRESH_HINTS.test(text);
  const precision = PRECISION_HINTS.test(text);
  return { tier, score, fresh, precision, codeLike, chars };
}

export function maxPolicy(profile, requestedThinking = {}) {
  const requestedPasses = Number(requestedThinking.reviewPasses || 0);
  let autoPasses = 0;
  if (profile.tier === "expert") autoPasses = 2;
  else if (profile.tier === "advanced" || profile.precision) autoPasses = 1;

  return {
    tier: profile.tier,
    reviewPasses: Math.max(requestedPasses, autoPasses),
    needsBrief: profile.tier !== "standard",
    autoSearchSuggested: profile.fresh,
    verifierStrict: profile.tier === "expert" || profile.precision,
    instruction: profile.tier === "expert"
      ? "NEXTURA MAX ENGINE: tugas kompleks. Susun jawaban dengan struktur yang benar, cek asumsi, konsistensi, edge case, dan jangan mengarang fakta. Gunakan konteks/tool yang tersedia. Tampilkan hanya hasil final yang berguna, bukan chain-of-thought."
      : profile.tier === "advanced"
        ? "NEXTURA MAX ENGINE: tugas menengah/teknis. Prioritaskan ketepatan, relevansi, konsistensi, dan verifikasi seperlunya. Jangan mengarang fakta atau hasil tool. Tampilkan hanya jawaban final."
        : "NEXTURA MAX ENGINE: jawab langsung, akurat, natural, dan sesuai pertanyaan. Jangan menambah profil/perkenalan atau detail yang tidak diminta."
  };
}

export function shouldAutoSearch(body = {}, profile = {}) {
  if (body.search === false || body.agent_search === false) return false;
  if (body.search === true || body.agent_search === true) return true;
  return Boolean(profile.autoSearchSuggested);
}

export function maxBriefPrompt(userRequest, profile) {
  return `Buat TASK BRIEF internal singkat untuk membantu model utama menjawab permintaan berikut. Jangan menjawab permintaan user. Jangan tampilkan chain-of-thought. Keluarkan hanya poin tujuan, constraint penting, fakta yang harus diverifikasi, dan kriteria jawaban bagus. Maksimal 220 kata.\n\nTIER: ${profile.tier}\nPERMINTAAN:\n${String(userRequest).slice(0, 14000)}`;
}

export function verifierPrompt(userRequest, answer, policy) {
  return `Kamu adalah verifier internal Nextura Max. Evaluasi jawaban terhadap permintaan user. Fokus pada kesalahan faktual, kontradiksi, instruksi yang terlewat, klaim tool yang tidak terbukti, kode yang jelas rusak, dan jawaban yang melebar dari pertanyaan. Jangan tampilkan proses berpikir. Jika perlu perbaikan, tulis ulang jawaban final yang lebih baik. Jika sudah bagus, kembalikan jawaban semula. Keluarkan HANYA jawaban final.\n\nTIER: ${policy.tier}\nSTRICT: ${policy.verifierStrict ? "yes" : "no"}\n\nUSER:\n${String(userRequest).slice(0, 14000)}\n\nANSWER:\n${String(answer).slice(0, 24000)}`;
}
