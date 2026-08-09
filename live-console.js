const MAX_LOGS = Math.max(50, Math.min(Number(process.env.WA_CONSOLE_MAX_LOGS || 500), 2000));
const logs = [];
let nextId = 1;

export function pushConsoleLog(type, payload = {}) {
  const entry = {
    id: nextId++,
    time: Date.now(),
    type: String(type || "info"),
    ...payload
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  return entry;
}

export function getConsoleLogs(after = 0) {
  const id = Number(after || 0);
  return logs.filter((item) => item.id > id);
}

export function clearConsoleLogs() {
  logs.length = 0;
}
