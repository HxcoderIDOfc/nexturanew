import fs from "node:fs";

if (!process.env.WA_SESSION_DIR) {
  process.env.WA_SESSION_DIR = fs.existsSync("/data")
    ? "/data/axynera-wa-session"
    : "./data/axynera-wa-session";
}

await import("./sdk-compat.js");
