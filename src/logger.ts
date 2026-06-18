/**
 * Minimal dependency-free structured logger.
 * - LOG_LEVEL: debug | info | warn | error (default info)
 * - LOG_JSON=1: emit one JSON object per line (recommended for prod ingestion)
 */

type Level = "debug" | "info" | "warn" | "error";

const WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): number {
  const lvl = (process.env.LOG_LEVEL as Level) || "info";
  return WEIGHT[lvl] ?? WEIGHT.info;
}

const asJson = () => process.env.LOG_JSON === "1";

function emit(level: Level, scope: string, msg: string, meta?: Record<string, unknown>) {
  if (WEIGHT[level] < minLevel()) return;
  const time = new Date().toISOString();
  const sink = level === "error" || level === "warn" ? console.error : console.log;

  if (asJson()) {
    sink(JSON.stringify({ time, level, scope, msg, ...meta }));
    return;
  }
  const tag = `${time} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  sink(meta && Object.keys(meta).length ? `${tag} ${msg} ${safe(meta)}` : `${tag} ${msg}`);
}

function safe(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return "[unserializable meta]";
  }
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit("debug", scope, m, meta),
    info: (m, meta) => emit("info", scope, m, meta),
    warn: (m, meta) => emit("warn", scope, m, meta),
    error: (m, meta) => emit("error", scope, m, meta),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger("mm");
