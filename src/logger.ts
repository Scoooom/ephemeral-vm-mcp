/**
 * STDERR-only logger.
 *
 * stdout is reserved for the stdio MCP transport — writing anything else there
 * corrupts the JSON-RPC stream. Everything goes to stderr.
 */

type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? order.info;

function emit(level: Level, msg: string, extra?: unknown): void {
  if (order[level] < threshold) return;
  const ts = new Date().toISOString();
  let line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (extra !== undefined) {
    line += " " + (extra instanceof Error ? (extra.stack ?? extra.message) : safeJson(extra));
  }
  process.stderr.write(line + "\n");
}

function safeJson(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const logger = {
  debug: (msg: string, extra?: unknown) => emit("debug", msg, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
};
