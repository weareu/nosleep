import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { DEFAULT_PORT, DEFAULT_DB_PATH } from "@nosleep/shared";
import { eventBus } from "./event-bus.js";
import { startDiscoveryBeacon, getLocalIp } from "./discovery.js";
import { initBroadcaster } from "./websocket/broadcast.js";
import { initServices, bootServices } from "./services/init.js";
import { registerAuth } from "./auth.js";
import { corsOptions } from "./cors-config.js";
import { registerWebSocket } from "./websocket/setup.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAllRoutes } from "./routes/index.js";
import { registerShutdown } from "./shutdown.js";
import { registerBrain } from "./brain/index.js";
import { registerHttpMcp } from "./mcp/http-endpoint.js";
import { pruneHeadlessTranscripts, describeLlmRouting } from "./lib/headless-claude.js";

const env = z.object({
  PORT: z.coerce.number().default(DEFAULT_PORT),
  DB_PATH: z.string().default(DEFAULT_DB_PATH),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  NOSLEEP_API_KEY: z.string().optional(),
  NOSLEEP_HOOK_SECRET: z.string().optional(),
}).parse(process.env);

// disableRequestLogging silences the per-request 2× "incoming request" /
// "request completed" pair that was drowning every other log line. We add
// back a slim onResponse hook below that logs only slow (>250ms) or
// non-2xx responses, so signal stays high without losing diagnostics.
// bodyLimit lifted from 1MB → 16MB so hook callbacks carrying a Read
// of a large file (or a big tool result blob) don't 413. The previous
// cap was silently turning every "Read large file" into a hook-error
// red banner in the user's Claude Code session.
const fastify = Fastify({
  logger: true,
  bodyLimit: 16 * 1024 * 1024,
  disableRequestLogging: true,
});

// Selective request logger: only the requests you'd actually act on.
fastify.addHook("onResponse", async (req, reply) => {
  const elapsed = reply.elapsedTime;
  const status = reply.statusCode;
  const tooSlow = elapsed > 250;
  const failed = status >= 400 && status !== 401; // 401s on every probe are noise
  if (!tooSlow && !failed) return;
  fastify.log.info(
    {
      method: req.method,
      url: req.url,
      status,
      ms: Math.round(elapsed),
      client: req.headers["x-client-app"] ?? undefined,
      ip: req.ip,
    },
    failed ? "request failed" : "slow request",
  );
});

// Event-loop-delay monitor: the wedge symptom is "port bound, no
// response" — that's the loop blocked for tens of seconds. monitorEventLoopDelay
// sniffs this without overhead. We report 1× per minute summary + an
// immediate WARN when max delay > 500ms.
{
  const histogram = (await import("node:perf_hooks")).monitorEventLoopDelay({
    resolution: 50,
  });
  histogram.enable();
  let warnedRecently = false;
  setInterval(() => {
    const max = histogram.max / 1e6; // ns → ms
    const p99 = histogram.percentile(99) / 1e6;
    const mean = histogram.mean / 1e6;
    if (max > 500 && !warnedRecently) {
      fastify.log.warn(
        { component: "event-loop", max_ms: Math.round(max), p99_ms: Math.round(p99), mean_ms: Math.round(mean) },
        "event loop stalled (possible wedge — max delay over threshold)",
      );
      warnedRecently = true;
      setTimeout(() => { warnedRecently = false; }, 30_000);
    }
  }, 5_000);
  setInterval(() => {
    fastify.log.info(
      {
        component: "event-loop",
        max_ms: Math.round(histogram.max / 1e6),
        p99_ms: Math.round(histogram.percentile(99) / 1e6),
        mean_ms: Math.round(histogram.mean / 1e6),
        stddev_ms: Math.round(histogram.stddev / 1e6),
      },
      "event-loop delay 1-minute summary",
    );
    histogram.reset();
  }, 60_000);
}

// Background LLM routing (Claude subscription vs OpenAI-compatible endpoint,
// per purpose). Validates NOSLEEP_LLM_* now — a bad config fails startup with
// a clear message instead of every brain call silently returning null.
fastify.log.info({ component: "headless-claude" }, describeLlmRouting());

// Headless `claude --print` calls (validator, question responder, brain
// extractors) run from a scratch cwd, but each still leaves a ~20KB transcript
// behind. Unpruned, that bucket grew to 66k files / 2.6GB in one month and —
// when the calls shared the real project's cwd — made `claude --resume` hang.
// Prune on boot and daily.
{
  const removed = pruneHeadlessTranscripts();
  if (removed > 0) {
    fastify.log.info({ component: "headless-claude", removed }, "pruned headless scratch transcripts");
  }
  setInterval(() => {
    const n = pruneHeadlessTranscripts();
    if (n > 0) {
      fastify.log.info({ component: "headless-claude", removed: n }, "pruned headless scratch transcripts");
    }
  }, 24 * 60 * 60 * 1000).unref();
}

await fastify.register(cors, corsOptions);
await fastify.register(websocket);
// BUG FIX: the previous 100 req/min cap silently 429'd hook callbacks
// once you had any concurrent activity, breaking brain ingestion + dashboard
// refresh. Hooks are auth-protected by the hook-secret and only ever called
// from localhost, so they don't need rate limiting at all. /health and /ws
// likewise — the watchdog probes /health every 30s and the dashboard polls
// it for the menu bar indicator.
const RATE_LIMIT_EXEMPT_PREFIXES = [
  "/api/hooks/",
  "/api/brain/hook-ingest/",
  "/api/sessions/register",
  "/api/sessions/drain",
];
await fastify.register(rateLimit, {
  max: 600,
  timeWindow: "1 minute",
  allowList: (req) => {
    const path = req.url.split("?")[0];
    if (path === "/health" || path === "/health/deep") return true;
    if (path === "/ws" || path === "/api/discovery") return true;
    return RATE_LIMIT_EXEMPT_PREFIXES.some((p) => path.startsWith(p));
  },
});

registerAuth(fastify, env.NOSLEEP_API_KEY);

const services = initServices({ dbPath: env.DB_PATH, logger: fastify.log });

initBroadcaster();
registerHealthRoutes(fastify, services);
registerWebSocket(fastify, env.NOSLEEP_API_KEY);

// Discovery endpoint (HTTP fallback for the UDP beacon)
const apiKeyPrefix = env.NOSLEEP_API_KEY ? env.NOSLEEP_API_KEY.slice(0, 8) : "";
fastify.get("/api/discovery", async () => ({
  host: getLocalIp(),
  port: env.PORT,
  apiKeyPrefix,
}));

// Tighter rate limit on session launches — must be set before route registration
fastify.addHook("onRoute", (routeOptions) => {
  if (routeOptions.url === "/api/sessions" && routeOptions.method === "POST") {
    routeOptions.config = {
      ...(routeOptions.config ?? {}),
      rateLimit: { max: 10, timeWindow: "1 minute" },
    };
  }
});

registerAllRoutes(fastify, services);
registerBrain(fastify, services.db);
registerHttpMcp(fastify, {
  db: services.db,
  serverUrl: `http://localhost:${env.PORT}`,
  apiKey: env.NOSLEEP_API_KEY ?? "",
});
bootServices(services);

// Wire alert events to push notifications
eventBus.on("alert:new", (alert) => {
  services.pushService.sendAlertToAll(alert).catch((err) => {
    fastify.log.error({ err }, "Failed to send push notifications");
  });
});

let discoveryBeacon: { stop: () => void } | null = null;
registerShutdown({ fastify, services, getDiscoveryBeacon: () => discoveryBeacon });

try {
  await fastify.listen({ port: env.PORT, host: "0.0.0.0" });
  discoveryBeacon = startDiscoveryBeacon(env.PORT, apiKeyPrefix, (msg, meta) => {
    fastify.log.info(meta ?? {}, msg);
  });
  fastify.log.info(`NoSleep server running on port ${env.PORT}`);
  fastify.log.info(`Discovery beacon broadcasting on ${getLocalIp()}:${env.PORT}`);

  // Refresh the GLOBAL session-registration hook (~/.claude/settings.json +
  // ~/.claude/nosleep-hooks/global-register.mjs) so the live artifact never
  // drifts from the template — session visibility for every non-NoSleep repo
  // depends on it. Idempotent; failure is non-fatal.
  try {
    const { installGlobalHooks } = await import("./orchestrator/hooks-installer.js");
    installGlobalHooks(env.PORT);
    fastify.log.info("global session-registration hook refreshed");
  } catch (err) {
    fastify.log.warn({ err }, "failed to refresh global registration hook (non-fatal)");
  }

  // Background vector index — DEFERRED. The embedding ONNX inference is
  // CPU-bound and synchronous per chunk; on a 18-project repo it blocks
  // the event loop for minutes, which times out /health probes and
  // causes the watchdog to kick → restart → re-index → kick. Wait 90s
  // after boot so /health proves healthy first, then proceed. Real fix
  // would be a worker_thread, but defer is cheap and stops the bleeding.
  setTimeout(() => {
    fastify.log.info({ component: "vector-indexer" }, "starting deferred startup index");
    services.vectorIndexer.indexAllActive().then((count) => {
      fastify.log.info({ component: "vector-indexer", count }, "deferred startup index complete");
    }).catch((err) => {
      fastify.log.warn({ component: "vector-indexer", err }, "deferred startup index failed");
    });
  }, 90_000);

  // Re-index when a plan is detected
  eventBus.on("plan:detected", (event: { filePath: string; projectId: string }) => {
    const project = services.db.prepare(`SELECT path FROM projects WHERE id = ?`).get(event.projectId) as { path: string } | undefined;
    if (project) {
      services.vectorIndexer.indexProject(event.projectId, project.path).catch((err) => {
        fastify.log.warn({ err }, `Vector re-index failed for project ${event.projectId}`);
      });
    }
  });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
