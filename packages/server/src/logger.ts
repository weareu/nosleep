/**
 * Shared structured logger.
 *
 * Backed by pino — same logger Fastify uses, so component logs interleave with
 * request logs in `server.log`. Each module gets a child logger tagged with
 * its component name; output is structured JSON in production and pretty
 * single-line in dev (driven by NODE_ENV).
 *
 * Replaces scattered console.log/warn/error calls. Loggers respect log levels
 * (silent in tests by default) and include timestamps + structured context.
 */

import pino, { type Logger } from "pino";

const ROOT = pino({
  // Silent during tests so 200+ unit tests don't spam the terminal
  level: process.env.NODE_ENV === "test" ? "silent" : (process.env.LOG_LEVEL ?? "info"),
  base: undefined, // omit pid/hostname — server.ts logs already include those
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Get a child logger tagged with the given component name. Reuse a single
 * instance per component — child loggers are cheap but caching avoids the
 * indirection on hot paths.
 */
const cache = new Map<string, Logger>();

export function getLogger(component: string): Logger {
  const existing = cache.get(component);
  if (existing) return existing;
  const child = ROOT.child({ component });
  cache.set(component, child);
  return child;
}

/**
 * Reset the cache. Tests may want fresh loggers per case.
 */
export function _resetLoggerCache(): void {
  cache.clear();
}
