const LAT = String(process.env.NEXTURA_LOCATION_LAT || "-6.8443892").trim();
const LNG = String(process.env.NEXTURA_LOCATION_LNG || "108.7638626").trim();

function compactAddress(address = {}) {
  const parts = [
    address.village || address.hamlet || address.suburb || address.neighbourhood,
    address.town || address.city || address.municipality || address.county,
    address.state,
    address.country
  ].filter(Boolean);

  return [...new Set(parts.map((x) => String(x).trim()).filter(Boolean))].join(", ");
}

async function resolveLocation() {
  if (String(process.env.NEXTURA_DEVELOPER_LOCATION || "").trim()) return;

  try {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", LAT);
    url.searchParams.set("lon", LNG);
    url.searchParams.set("zoom", "18");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", "id");

    const response = await fetch(url, {
      headers: {
        "user-agent": "NexturaAI-LocationResolver/1.0",
        accept: "application/json"
      },
      signal: AbortSignal.timeout(Number(process.env.NEXTURA_LOCATION_TIMEOUT_MS || 8000))
    });

    if (!response.ok) throw new Error(`reverse geocode HTTP ${response.status}`);
    const data = await response.json();
    const readable = compactAddress(data?.address) || String(data?.display_name || "").trim();
    if (readable) process.env.NEXTURA_DEVELOPER_LOCATION = readable;
  } catch (error) {
    console.warn(`[location-bootstrap] Reverse geocode gagal: ${error.message}`);
    process.env.NEXTURA_DEVELOPER_LOCATION = process.env.NEXTURA_LOCATION_FALLBACK || "Jawa Barat, Indonesia";
  }
}

await resolveLocation();
console.log(`[location-bootstrap] Public location: ${process.env.NEXTURA_DEVELOPER_LOCATION}`);
await import("./sdk-compat.js");
