/**
 * Mobile client-log reporter — forwards JS errors, fetch failures, and
 * explicit diagnostics to the NoSleep server's /api/client-log endpoint.
 * The endpoint is auth-exempt server-side so first-launch failures still
 * surface even before the user pastes their API key.
 *
 * Why this exists: I can't read the iPhone's local logs remotely. Routing
 * client diagnostics back to the server's log file means I can grep
 * ~/.nosleep/server.log for [client-log] entries to see exactly what the
 * mobile app is hitting.
 *
 * Two pieces:
 *   1. report(level, source, message, ...) — explicit caller
 *   2. installGlobalErrorReporter() — hooks ErrorUtils and console.error
 */

import Constants from "expo-constants";
import { Platform } from "react-native";
import { getServerConfigSync } from "../config";

const APP_NAME = "nosleep-mobile";
const APP_VERSION =
  (Constants.expoConfig?.version as string | undefined) ?? "unknown";

type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

interface ReportPayload {
  level: LogLevel;
  source: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

// Buffer the most recent N reports so multiple early-boot errors don't
// race a missing server config. Flushed once getServerConfigSync returns
// a real URL.
const PENDING_LIMIT = 50;
const pending: ReportPayload[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function postReport(payload: ReportPayload): Promise<boolean> {
  const cfg = getServerConfigSync();
  if (!cfg || !cfg.apiUrl) return false;
  try {
    const res = await fetch(`${cfg.apiUrl}/api/client-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        app: APP_NAME,
        appVersion: APP_VERSION,
        platform: Platform.OS,
      }),
    });
    return res.ok || res.status === 204;
  } catch {
    return false;
  }
}

async function flushPending(): Promise<void> {
  while (pending.length > 0) {
    const next = pending[0];
    const ok = await postReport(next);
    if (!ok) break;
    pending.shift();
  }
  if (pending.length > 0) {
    // Re-arm with backoff so we keep trying until the server is reachable.
    flushTimer && clearTimeout(flushTimer);
    flushTimer = setTimeout(() => void flushPending(), 5000);
  } else {
    flushTimer = null;
  }
}

export function report(
  level: LogLevel,
  source: string,
  message: string,
  context?: Record<string, unknown>,
  stack?: string,
): void {
  const payload: ReportPayload = { level, source, message, context, stack };
  // Try direct, fall back to pending queue.
  void postReport(payload).then((ok) => {
    if (ok) return;
    if (pending.length >= PENDING_LIMIT) pending.shift();
    pending.push(payload);
    if (!flushTimer) flushTimer = setTimeout(() => void flushPending(), 2000);
  });
}

let installed = false;

export function installGlobalErrorReporter(): void {
  if (installed) return;
  installed = true;

  // RN's ErrorUtils is the global JS error handler. We chain ours after
  // any existing handler so we report THEN let RN's red-box show in dev.
  type ErrorUtilsT = {
    getGlobalHandler: () => (error: Error, isFatal: boolean) => void;
    setGlobalHandler: (h: (error: Error, isFatal: boolean) => void) => void;
  };
  const eu = (globalThis as unknown as { ErrorUtils?: ErrorUtilsT }).ErrorUtils;
  if (eu) {
    const previous = eu.getGlobalHandler();
    eu.setGlobalHandler((error, isFatal) => {
      report(
        isFatal ? "fatal" : "error",
        "uncaught",
        error?.message ?? String(error),
        { isFatal },
        error?.stack,
      );
      if (previous) previous(error, isFatal);
    });
  }

  // Wrap console.error so React's "Warning:" / network spew also lands.
  const origConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      const msg = args
        .map((a) =>
          a instanceof Error
            ? a.message
            : typeof a === "string"
              ? a
              : JSON.stringify(a),
        )
        .join(" ");
      const stack =
        args.find((a): a is Error => a instanceof Error)?.stack ?? undefined;
      report("error", "console", msg, undefined, stack);
    } catch {
      // never let logging break the app
    }
    origConsoleError(...args);
  };

  // Unhandled promise rejections.
  type GlobalWithPromiseRejection = {
    addEventListener?: (event: string, cb: (e: unknown) => void) => void;
    HermesInternal?: { enablePromiseRejectionTracker?: (opts: object) => void };
  };
  const g = globalThis as unknown as GlobalWithPromiseRejection;
  g.HermesInternal?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onUnhandled: (id: unknown, error: Error | unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      report("error", "promise", msg, { rejectionId: String(id) }, stack);
    },
  });
}
