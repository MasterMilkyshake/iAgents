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

function emit(level: LogLevel, message: string, detail?: unknown): void {
  if (ORDER[level] < ORDER[threshold]) return;
  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (detail !== undefined) {
    line += ": " + (typeof detail === "string" || detail instanceof Error ? errorMessage(detail) : JSON.stringify(detail));
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
