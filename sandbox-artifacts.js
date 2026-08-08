import path from "node:path";
import fs from "node:fs/promises";
import dns from "node:dns/promises";
import net from "node:net";
import { PDFDocument, StandardFonts } from "pdf-lib";
import puppeteer from "puppeteer-core";

const SANDBOX_ROOT = path.resolve(process.env.TOOL_SANDBOX_ROOT || "/tmp/nextura-sandbox");
const MAX_DOWNLOAD_BYTES = Number(process.env.TOOL_MAX_DOWNLOAD_BYTES || 10 * 1024 * 1024);
const MAX_PDF_CHARS = Number(process.env.TOOL_MAX_PDF_CHARS || 120000);
const SCREENSHOT_TIMEOUT_MS = Number(process.env.TOOL_SCREENSHOT_TIMEOUT_MS || 45000);
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium-browser";

function safeWithin(relative) {
  const target = path.resolve(SANDBOX_ROOT, String(relative || "."));
  const rel = path.relative(SANDBOX_ROOT, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path di luar sandbox ditolak");
  return target;
}

function isPrivateIp(ip) {
  if (!net.isIP(ip)) return true;
  if (["127.0.0.1", "0.0.0.0", "::1"].includes(ip)) return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("169.254.")) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return /^(fc|fd|fe80)/i.test(ip);
}

async function validatePublicHttps(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Hanya URL HTTPS yang diizinkan");
  const records = await dns.lookup(url.hostname, { all: true });
  if (!records.length || records.some((r) => isPrivateIp(r.address))) throw new Error("Host lokal/internal ditolak");
  return url;
}

async function ensureSandbox() {
  await fs.mkdir(SANDBOX_ROOT, { recursive: true });
}

export async function sandboxDownload(input = {}) {
  await ensureSandbox();
  const url = await validatePublicHttps(input.url);
  const fallbackName = path.basename(url.pathname) || `download-${Date.now()}`;
  const target = safeWithin(input.path || fallbackName);
  await fs.mkdir(path.dirname(target), { recursive: true });

  const response = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "Nextura-Sandbox-Downloader/1.0", accept: "*/*" },
    signal: AbortSignal.timeout(Number(input.timeout_ms || 45000))
  });
  if (!response.ok || !response.body) throw new Error(`Download gagal HTTP ${response.status}`);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw new Error("File melebihi batas download sandbox");
    }
    chunks.push(Buffer.from(value));
  }
  await fs.writeFile(target, Buffer.concat(chunks));
  return {
    ok: true,
    action: "sandbox_download",
    path: path.relative(SANDBOX_ROOT, target),
    bytes: total,
    content_type: response.headers.get("content-type") || "",
    final_url: response.url
  };
}

function wrapText(text, maxChars = 92) {
  const lines = [];
  for (const raw of String(text).replace(/\r/g, "").split("\n")) {
    if (!raw) { lines.push(""); continue; }
    let current = "";
    for (const word of raw.split(/\s+/)) {
      if (!current) current = word;
      else if ((current + " " + word).length <= maxChars) current += " " + word;
      else { lines.push(current); current = word; }
    }
    if (current) lines.push(current);
  }
  return lines;
}

export async function sandboxPdf(input = {}) {
  await ensureSandbox();
  const target = safeWithin(input.path || `nextura-${Date.now()}.pdf`);
  if (!target.toLowerCase().endsWith(".pdf")) throw new Error("Path PDF harus berakhiran .pdf");
  const text = String(input.content ?? input.text ?? "");
  if (!text) throw new Error("Isi PDF wajib diisi");
  if (text.length > MAX_PDF_CHARS) throw new Error("Isi PDF terlalu panjang");
  await fs.mkdir(path.dirname(target), { recursive: true });

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = 595.28;
  const height = 841.89;
  const margin = 48;
  const fontSize = Number(input.font_size || 11);
  const lineHeight = fontSize * 1.45;
  const title = String(input.title || "").trim();
  const lines = wrapText(text);
  let page = pdf.addPage([width, height]);
  let y = height - margin;

  if (title) {
    page.drawText(title.slice(0, 180), { x: margin, y, size: 18, font: bold });
    y -= 30;
  }

  for (const line of lines) {
    if (y < margin + lineHeight) {
      page = pdf.addPage([width, height]);
      y = height - margin;
    }
    page.drawText(line.slice(0, 500), { x: margin, y, size: fontSize, font });
    y -= lineHeight;
  }

  const bytes = await pdf.save();
  await fs.writeFile(target, bytes);
  return { ok: true, action: "sandbox_pdf", path: path.relative(SANDBOX_ROOT, target), bytes: bytes.length, pages: pdf.getPageCount() };
}

export async function sandboxScreenshot(input = {}) {
  await ensureSandbox();
  const url = await validatePublicHttps(input.url);
  const target = safeWithin(input.path || `screenshot-${Date.now()}.png`);
  if (!/\.(?:png|jpe?g)$/i.test(target)) throw new Error("Screenshot harus disimpan sebagai .png/.jpg/.jpeg");
  await fs.mkdir(path.dirname(target), { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    env: { ...process.env, HOME: SANDBOX_ROOT, TMPDIR: SANDBOX_ROOT }
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: Math.max(320, Math.min(Number(input.width || 1365), 2400)),
      height: Math.max(240, Math.min(Number(input.height || 768), 2400)),
      deviceScaleFactor: Math.max(1, Math.min(Number(input.device_scale_factor || 1), 2))
    });
    await page.goto(url.toString(), { waitUntil: "networkidle2", timeout: Math.min(Number(input.timeout_ms || SCREENSHOT_TIMEOUT_MS), SCREENSHOT_TIMEOUT_MS) });
    await page.screenshot({ path: target, fullPage: input.full_page !== false, type: target.toLowerCase().endsWith(".png") ? "png" : "jpeg", quality: target.toLowerCase().endsWith(".png") ? undefined : 88 });
    const stat = await fs.stat(target);
    return { ok: true, action: "sandbox_screenshot", path: path.relative(SANDBOX_ROOT, target), bytes: stat.size, url: page.url(), title: await page.title() };
  } finally {
    await browser.close();
  }
}
