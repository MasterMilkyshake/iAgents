import { closeSync, fstatSync, ftruncateSync, openSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: LogLevel = isLogLevel(process.env.IAGENTS_LOG_LEVEL) ? process.env.IAGENTS_LOG_LEVEL : "info";

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && value in ORDER;
}

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

/** Strips bearer tokens and API-key-shaped strings so they never land in log files. */
export function redact(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
    .replace(/\b(?:key|crsr|sk|xai)[-_][A-Za-z0-9_-]{12,}\b/g, "<redacted>");
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Subprocess errors embed argv (including message text); gateway errors can echo response bodies.
 * Keep only machine-readable error codes in relay logs. probe/doctor remain explicit diagnostics.
 */
export function errorDiagnostic(detail: unknown): string {
  if (detail === null || typeof detail !== "object") return "error detail omitted";
  const e = detail as { code?: unknown; status?: unknown; signal?: unknown };
  const fields: string[] = [];
  if (typeof e.code === "number" || (typeof e.code === "string" && /^E[A-Z0-9_]{1,40}$/.test(e.code))) fields.push(`code=${e.code}`);
  if (typeof e.status === "number") fields.push(`status=${e.status}`);
  if (typeof e.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(e.signal)) fields.push(`signal=${e.signal}`);
  return fields.join(" ") || "error detail omitted";
}

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Truncate the existing inode, preserving launchd's open append-mode stdout/stderr descriptors. */
export function rotateLogIfNeeded(path: string, maxBytes = MAX_LOG_BYTES): boolean {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Log size threshold must be a positive integer");
  let fd: number;
  try {
    fd = openSync(path, "r+");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  try {
    if (fstatSync(fd).size < maxBytes) return false;
    ftruncateSync(fd, 0);
    return true;
  } finally {
    closeSync(fd);
  }
}

/** Bound logs even when the relay runs for weeks without restarting. */
export function maintainLog(path: string): () => void {
  const check = () => {
    try {
      if (rotateLogIfNeeded(path)) log.info("Relay log truncated at the size limit");
    } catch (err) {
      log.warn("Couldn't rotate the relay log", err);
    }
  };
  check();
  const timer = setInterval(check, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

function emit(level: LogLevel, message: string, detail?: unknown): void {
  if (ORDER[level] < ORDER[threshold]) return;
  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (detail !== undefined) {
    line += ": " + errorDiagnostic(detail);
  }
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(redact(line) + "\n");
}

export const log = {
  debug: (message: string, detail?: unknown) => emit("debug", message, detail),
  info: (message: string, detail?: unknown) => emit("info", message, detail),
  warn: (message: string, detail?: unknown) => emit("warn", message, detail),
  error: (message: string, detail?: unknown) => emit("error", message, detail),
};
