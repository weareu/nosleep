/**
 * Phase 10 — retroactive backfill script.
 *
 * Walks the existing nosleep.db sessions/session_events tables and emits
 * artifacts to /api/brain/ingest in chronological order, mapping NoSleep
 * event_type → brain artifact kind. Throttled, resumable.
 *
 * Run via:  npx tsx packages/server/scripts/brain-backfill.ts \
 *             --org=org_personal --since=2025-01-01 [--dry-run] [--limit=10000]
 *
 * Resumable: writes a cursor file (data/brain/<org>/.backfill-cursor.json)
 * containing {last_event_id}. Re-running picks up where the previous run
 * stopped.
 */
/* eslint-disable no-console */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

interface BackfillArgs {
  org_id: string;
  since: number;
  api_url: string;
  api_key: string;
  rate_per_sec: number;
  dry_run: boolean;
  limit: number;
  data_dir: string;
}

interface NosleepSessionRow {
  id: string;
  project_id: string;
  account_id: string;
  goal_text: string;
  started_at: string;
  ended_at: string | null;
  status: string;
}

interface NosleepEventRow {
  id: number;
  session_id: string;
  event_type: string;
  payload: string;
  created_at: string;
}

interface CursorState {
  last_event_id: number;
  last_session_id: string | null;
  total_emitted: number;
}

const KIND_MAP: Record<string, string> = {
  prompt_user: "conversation/turn/user",
  user_message: "conversation/turn/user",
  assistant_message: "conversation/turn/assistant",
  tool_use: "agent/mcp_call",
  tool_result: "agent/mcp_result",
  pre_tool_use: "agent/mcp_call",
  post_tool_use: "agent/mcp_result",
  goal_update: "workflow/strategy_node_snapshot",
  validation_result: "workflow/validation_result",
  drift_detected: "workflow/supervision_event",
  compaction: "workflow/supervision_event",
  escalation_created: "workflow/supervision_event",
  default: "conversation/turn/system",
};

function mapEventToKind(eventType: string): string {
  return KIND_MAP[eventType] ?? KIND_MAP.default;
}

function parseArgs(): BackfillArgs {
  const args: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq === -1) {
        args[a.slice(2)] = "true";
      } else {
        args[a.slice(2, eq)] = a.slice(eq + 1);
      }
    }
  }
  const apiKey = args.api_key ?? process.env.NOSLEEP_API_KEY ?? "";
  if (!apiKey) {
    console.error("missing --api_key= or NOSLEEP_API_KEY env");
    process.exit(2);
  }
  return {
    org_id: args.org ?? "org_personal",
    since: args.since ? Math.floor(Date.parse(args.since) / 1000) : 0,
    api_url: args.api_url ?? "http://localhost:3777",
    api_key: apiKey,
    rate_per_sec: args.rate ? Number(args.rate) : 100,
    dry_run: args.dry_run === "true",
    limit: args.limit ? Number(args.limit) : 100_000,
    data_dir: args.data_dir ?? "data",
  };
}

function readCursor(cursorPath: string): CursorState {
  if (!fs.existsSync(cursorPath)) {
    return { last_event_id: 0, last_session_id: null, total_emitted: 0 };
  }
  try {
    return JSON.parse(fs.readFileSync(cursorPath, "utf8")) as CursorState;
  } catch {
    return { last_event_id: 0, last_session_id: null, total_emitted: 0 };
  }
}

function writeCursor(cursorPath: string, state: CursorState): void {
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(cursorPath, JSON.stringify(state, null, 2));
}

async function postIngest(
  args: BackfillArgs,
  body: Record<string, unknown>,
): Promise<void> {
  if (args.dry_run) return;
  const res = await fetch(`${args.api_url}/api/brain/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": args.api_key,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ingest failed ${res.status}: ${text}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(
    `brain-backfill org=${args.org_id} since=${args.since} api=${args.api_url} dry_run=${args.dry_run}`,
  );

  const dbPath = path.join(args.data_dir, "nosleep.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`nosleep.db not found at ${dbPath}`);
    process.exit(2);
  }
  const db = new Database(dbPath, { readonly: true });

  const cursorPath = path.join(
    args.data_dir,
    "brain",
    args.org_id,
    ".backfill-cursor.json",
  );
  const cursor = readCursor(cursorPath);
  console.log(
    `resuming from event_id=${cursor.last_event_id}, total_emitted=${cursor.total_emitted}`,
  );

  const sessions = db
    .prepare(
      `SELECT s.id, s.project_id, s.account_id, s.goal_text, s.started_at,
              s.ended_at, s.status
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
        WHERE p.org_id = ?`,
    )
    .all(args.org_id) as NosleepSessionRow[];
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  console.log(`found ${sessions.length} sessions in org ${args.org_id}`);

  const minBatchInterval = 1000 / args.rate_per_sec;
  let emitted = 0;
  let lastEmitMs = 0;

  const events = db
    .prepare(
      `SELECT id, session_id, event_type, payload, created_at
         FROM session_events
        WHERE id > ?
          AND strftime('%s', created_at) >= ?
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(cursor.last_event_id, args.since, args.limit) as NosleepEventRow[];
  console.log(`processing ${events.length} session_events`);

  for (const ev of events) {
    const session = sessionById.get(ev.session_id);
    if (!session) continue;

    const kind = mapEventToKind(ev.event_type);
    const tsSec = Math.floor(Date.parse(ev.created_at) / 1000);
    const payloadObj = (() => {
      try {
        return JSON.parse(ev.payload);
      } catch {
        return {};
      }
    })();

    const text =
      typeof payloadObj.text === "string"
        ? payloadObj.text
        : typeof payloadObj.message === "string"
          ? payloadObj.message
          : JSON.stringify(payloadObj);

    const ingestBody = {
      kind,
      content: text,
      content_type: "text/plain",
      org_id: args.org_id,
      project_id: session.project_id,
      session_id: session.id,
      ts: tsSec,
      origin: { tool: "nosleep-backfill", actor: ev.event_type },
      kind_specific_meta: {
        event_type: ev.event_type,
        original_event_id: ev.id,
        ...payloadObj,
      },
      schema_version: 1,
    };

    try {
      const now = Date.now();
      const wait = lastEmitMs + minBatchInterval - now;
      if (wait > 0) await sleep(wait);
      await postIngest(args, ingestBody);
      lastEmitMs = Date.now();
      emitted += 1;
      cursor.last_event_id = ev.id;
      cursor.last_session_id = ev.session_id;
      cursor.total_emitted = (cursor.total_emitted ?? 0) + 1;

      if (emitted % 100 === 0) {
        writeCursor(cursorPath, cursor);
        console.log(
          `…emitted ${emitted}/${events.length} (cursor=${cursor.last_event_id})`,
        );
      }
    } catch (e) {
      console.error(`failed at event_id=${ev.id}: ${e}`);
      writeCursor(cursorPath, cursor);
      process.exit(3);
    }
  }

  writeCursor(cursorPath, cursor);
  console.log(
    `done — emitted=${emitted} total=${cursor.total_emitted} cursor=${cursor.last_event_id}`,
  );
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export { mapEventToKind };
