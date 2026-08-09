import fs from "node:fs";

if (!process.env.WA_SESSION_DIR) {
  process.env.WA_SESSION_DIR = fs.existsSync("/data")
    ? "/data/nextura-wa-session"
    : "./data/wa-session";
}

await import("./sdk-compat.js");
