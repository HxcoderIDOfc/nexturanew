function latestUserText(messages = []) {
  const message = [...messages].reverse().find((item) => item?.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" || part?.type === "input_text")
    .map((part) => part.text || "")
    .join("\n");
}

function explicitBoolean(input, keys = []) {
  for (const key of keys) {
    if (typeof input?.[key] === "boolean") return { explicit: true, value: input[key], key };
  }
  return { explicit: false, value: undefined, key: null };
}

function asksFreshInformation(text = "") {
  return /\b(terbaru|terkini|hari ini|sekarang|saat ini|latest|current|today|berita|news|harga sekarang|status sekarang|update terbaru|rilis terbaru|versi terbaru|cek web|cari di web|search web|internet|online|dokumentasi terbaru|docs terbaru)\b/i.test(text);
}

function asksDirectWebRead(text = "") {
  const hasDomain = /https?:\/\/|\b(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i.test(text);
  const wantsRead = /\b(buka|baca|cek|lihat|kunjungi|akses|read|open|visit|dokumentasi|docs|website|web|situs|halaman)\b/i.test(text);
  return hasDomain && wantsRead;
}

function needsCarefulVerification(text = "", profile = {}) {
  if (profile?.tier === "advanced" || profile?.tier === "expert" || profile?.precision) return true;
  return /\b(verifikasi|verify|periksa ulang|cek ulang|review|audit|production|production-ready|security|keamanan|bug|debug|race condition|edge case|analisis mendalam|bandingkan|hitung dengan teliti|pastikan benar|jangan salah|akurat|akurasi)\b/i.test(text);
}

function needsDeepThinking(text = "", profile = {}) {
  if (profile?.tier === "advanced" || profile?.tier === "expert") return true;
  return /\b(analisis|reasoning|logika|pecahkan|selesaikan|arsitektur|debug|coding kompleks|matematika|strategi|rancang|desain sistem|optimasi|jelaskan kenapa|mengapa bisa|step by step)\b/i.test(text);
}

export function resolveAutoBooleanFeatures(input = {}, profile = {}) {
  const text = latestUserText(input.messages || []).trim();

  const searchExplicit = explicitBoolean(input, ["search", "agent_search"]);
  const reviewExplicit = explicitBoolean(input, ["review"]);
  const thinkingExplicit = explicitBoolean(input, ["thinking"]);

  // URL yang sudah jelas lebih cocok ke web reader daripada menyalakan search tambahan.
  const autoSearch = asksFreshInformation(text) && !asksDirectWebRead(text);
  const autoReview = needsCarefulVerification(text, profile);
  const autoThinking = needsDeepThinking(text, profile);

  const search = searchExplicit.explicit ? searchExplicit.value : autoSearch;
  const review = reviewExplicit.explicit ? reviewExplicit.value : autoReview;
  const thinking = thinkingExplicit.explicit ? thinkingExplicit.value : autoThinking;

  return {
    values: {
      search,
      agent_search: search,
      review,
      thinking
    },
    source: {
      search: searchExplicit.explicit ? "explicit" : "auto",
      review: reviewExplicit.explicit ? "explicit" : "auto",
      thinking: thinkingExplicit.explicit ? "explicit" : "auto"
    },
    reasons: {
      search: search ? (autoSearch ? "fresh_or_web_information" : "explicit_true") : (searchExplicit.explicit ? "explicit_false" : "not_needed"),
      review: review ? (autoReview ? "precision_or_complexity" : "explicit_true") : (reviewExplicit.explicit ? "explicit_false" : "not_needed"),
      thinking: thinking ? (autoThinking ? "reasoning_or_complexity" : "explicit_true") : (thinkingExplicit.explicit ? "explicit_false" : "not_needed")
    }
  };
}

export function autoBooleanSystemPrompt(flags) {
  return `NEXTURA AUTO FEATURE ROUTER:\n- search=${flags.values.search}\n- review=${flags.values.review}\n- thinking=${flags.values.thinking}\nKeputusan ini hanya mengatur fitur boolean internal. Jangan menyebut konfigurasi ini kepada pengguna kecuali mereka secara khusus bertanya tentang status fitur.`;
}
