/**
 * Sleep-time consolidator (Phase 22-F): soft-archives thoughts nobody has
 * recalled in N days, plus thoughts superseded by an active thought.
 * Never deletes, always reversible. Time travel is done by passing `now_sec`
 * (and faking Date for the recall stamp on the read path).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-consolidate-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;
// Capture enqueues the metadata Haiku extractor — keep tests off the real CLI.
process.env.NOSLEEP_BRAIN_DISABLE_TRIAGE = "1";

import { captureThought } from "../thoughts/capture.js";
import { getThought } from "../thoughts/get.js";
import { listThoughts } from "../thoughts/list.js";
import { searchThoughts } from "../thoughts/search.js";
import { addThoughtRef } from "../thoughts/refs.js";
import {
  runThoughtConsolidation,
  unarchiveThoughts,
  listConsolidationRuns,
} from "../jobs/thought-consolidator.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";

const DAY = 86_400;
let orgSeq = 0;

/** Fresh org per test so runs don't see each other's thoughts. */
function freshOrg(): string {
  orgSeq += 1;
  const org = `org_consol_${orgSeq}`;
  activeDbFor(org);
  return org;
}

function capture(org: string, content: string, extra: { strategy_node_ref?: string } = {}): string {
  return captureThought({
    content,
    org_id: org,
    project_id: "proj_c",
    source_kind: "mcp_capture",
    ...extra,
  }).id;
}

/** Read visibility without going through getThought — that read path stamps
 *  last_recalled_at, which would itself change what the consolidator does. */
function visibilityOf(org: string, id: string): string | undefined {
  const row = activeDbFor(org)
    .prepare(`SELECT visibility FROM thoughts WHERE id = ?`)
    .get(id) as { visibility: string } | undefined;
  return row?.visibility;
}

const nowSec = () => Math.floor(Date.now() / 1000);

beforeAll(() => {
  activeDbFor("org_consol_0");
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("sleep-time consolidator", () => {
  test("archives a thought unrecalled for longer than stale_days", () => {
    const org = freshOrg();
    const id = capture(org, "old forgotten idea about caching");
    const res = runThoughtConsolidation({ org_id: org, now_sec: nowSec() + 120 * DAY });
    expect(res.archived_stale).toEqual([id]);
    expect(visibilityOf(org, id)).toBe("archived");
  });

  test("keeps a thought that is younger than stale_days", () => {
    const org = freshOrg();
    const id = capture(org, "fresh idea");
    const res = runThoughtConsolidation({ org_id: org, now_sec: nowSec() + 30 * DAY });
    expect(res.archived_stale).toEqual([]);
    expect(visibilityOf(org, id)).toBe("active");
  });

  test("a recent recall (search hit) protects an old thought", () => {
    const org = freshOrg();
    const recalled = capture(org, "zebra migration notes");
    const forgotten = capture(org, "unrelated llama notes");
    // Recall the zebra thought 100 days from now via the real search path.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date((nowSec() + 100 * DAY) * 1000));
    const hits = searchThoughts({ orgId: org, projectId: "proj_c", query: "zebra" });
    expect(hits.map((h) => h.thought.id)).toContain(recalled);
    vi.useRealTimers();

    const res = runThoughtConsolidation({ org_id: org, now_sec: nowSec() + 120 * DAY });
    expect(res.archived_stale).toEqual([forgotten]);
    expect(visibilityOf(org, recalled)).toBe("active");
  });

  test("dry run reports candidates but changes nothing, and is recorded", () => {
    const org = freshOrg();
    const id = capture(org, "dry run candidate");
    const res = runThoughtConsolidation({
      org_id: org,
      now_sec: nowSec() + 120 * DAY,
      dry_run: true,
    });
    expect(res.dry_run).toBe(true);
    expect(res.archived_stale).toEqual([id]);
    expect(visibilityOf(org, id)).toBe("active");

    const runs = listConsolidationRuns(org, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].dry_run).toBe(true);
    expect(runs[0].archived_stale).toEqual([id]);
  });

  test("thoughts that predate recall tracking get a grace period from when tracking started", () => {
    const org = freshOrg();
    const id = capture(org, "captured long before recall tracking existed");
    // Backdate capture to 300 days ago — recall tracking (migration 013) was
    // only just applied, so last_recalled_at=NULL says nothing about usage.
    activeDbFor(org)
      .prepare(`UPDATE thoughts SET created_at = ? WHERE id = ?`)
      .run(nowSec() - 300 * DAY, id);

    const soon = runThoughtConsolidation({ org_id: org, now_sec: nowSec() + 30 * DAY });
    expect(soon.archived_stale).toEqual([]);
    expect(visibilityOf(org, id)).toBe("active");

    const later = runThoughtConsolidation({ org_id: org, now_sec: nowSec() + 100 * DAY });
    expect(later.archived_stale).toEqual([id]);
  });

  test("a live strategy node pins its thoughts; a finished one does not", () => {
    const org = freshOrg();
    const pinned = capture(org, "plan for live node", { strategy_node_ref: "node_live" });
    const done = capture(org, "plan for finished node", { strategy_node_ref: "node_done" });
    const res = runThoughtConsolidation({
      org_id: org,
      now_sec: nowSec() + 120 * DAY,
      isStrategyNodeLive: (ref) => ref === "node_live",
    });
    expect(res.archived_stale).toEqual([done]);
    expect(res.protected.strategy).toBe(1);
    expect(visibilityOf(org, pinned)).toBe("active");
  });

  test("without a strategy resolver every strategy-linked thought is protected", () => {
    const org = freshOrg();
    const pinned = capture(org, "strategy linked", { strategy_node_ref: "node_x" });
    const res = runThoughtConsolidation({ org_id: org, now_sec: nowSec() + 120 * DAY });
    expect(res.archived_stale).toEqual([]);
    expect(visibilityOf(org, pinned)).toBe("active");
  });

  test("an inbound ref from a recently-active thought protects the target", () => {
    const org = freshOrg();
    const target = capture(org, "foundational decision");
    const db = activeDbFor(org);
    // Target is 200 days old; referrer captured "today" relative to the run.
    db.prepare(`UPDATE thoughts SET created_at = ?, last_recalled_at = ? WHERE id = ?`).run(
      nowSec() - 200 * DAY,
      nowSec() - 200 * DAY,
      target,
    );
    const referrer = capture(org, "follow-up that refines the decision");
    addThoughtRef({ org_id: org, from_thought_id: referrer, to_thought_id: target, relation: "refines" });

    const res = runThoughtConsolidation({ org_id: org, now_sec: nowSec() + 10 * DAY });
    expect(res.archived_stale).toEqual([]);
    expect(res.protected.recent_inbound_ref).toBe(1);
    expect(visibilityOf(org, target)).toBe("active");
  });

  test("a thought superseded by an active thought is archived immediately", () => {
    const org = freshOrg();
    const oldT = capture(org, "use JWT HS256");
    const newT = capture(org, "use JWT ES256 instead");
    addThoughtRef({ org_id: org, from_thought_id: newT, to_thought_id: oldT, relation: "supersedes" });

    const res = runThoughtConsolidation({ org_id: org, now_sec: nowSec() });
    expect(res.archived_superseded).toEqual([oldT]);
    expect(visibilityOf(org, oldT)).toBe("archived");
    expect(visibilityOf(org, newT)).toBe("active");
  });

  test("a supersedes ref from an archived thought does not archive the target", () => {
    const org = freshOrg();
    const oldT = capture(org, "target");
    const newT = capture(org, "superseder that was itself archived");
    addThoughtRef({ org_id: org, from_thought_id: newT, to_thought_id: oldT, relation: "supersedes" });
    activeDbFor(org).prepare(`UPDATE thoughts SET visibility = 'archived' WHERE id = ?`).run(newT);

    const res = runThoughtConsolidation({ org_id: org, now_sec: nowSec() });
    expect(res.archived_superseded).toEqual([]);
    expect(visibilityOf(org, oldT)).toBe("active");
  });

  test("respects max_per_run and reports that it was capped", () => {
    const org = freshOrg();
    for (let i = 0; i < 5; i++) capture(org, `bulk thought ${i}`);
    const res = runThoughtConsolidation({
      org_id: org,
      now_sec: nowSec() + 120 * DAY,
      max_per_run: 2,
    });
    expect(res.archived_stale).toHaveLength(2);
    expect(res.capped).toBe(true);
    const stillActive = listThoughts({ orgId: org, projectId: "proj_c", limit: 50 });
    expect(stillActive).toHaveLength(3);
  });

  test("never deletes rows", () => {
    const org = freshOrg();
    for (let i = 0; i < 4; i++) capture(org, `keep row ${i}`);
    const count = () =>
      (activeDbFor(org).prepare(`SELECT COUNT(*) AS n FROM thoughts`).get() as { n: number }).n;
    const before = count();
    runThoughtConsolidation({ org_id: org, now_sec: nowSec() + 400 * DAY });
    expect(count()).toBe(before);
  });
});

describe("archived thoughts stay reachable", () => {
  test("search/list hide archived by default; include_archived brings them back; get always works", () => {
    const org = freshOrg();
    const id = capture(org, "quokka retention policy");
    runThoughtConsolidation({ org_id: org, now_sec: nowSec() + 120 * DAY });

    expect(searchThoughts({ orgId: org, projectId: "proj_c", query: "quokka" })).toHaveLength(0);
    expect(listThoughts({ orgId: org, projectId: "proj_c" })).toHaveLength(0);

    const hits = searchThoughts({
      orgId: org,
      projectId: "proj_c",
      query: "quokka",
      includeArchived: true,
    });
    expect(hits.map((h) => h.thought.id)).toEqual([id]);
    const listed = listThoughts({ orgId: org, projectId: "proj_c", includeArchived: true });
    expect(listed.map((t) => t.id)).toEqual([id]);

    expect(getThought(org, id, new Set())?.visibility).toBe("archived");
  });

  test("include_archived does not surface merged (hidden) thoughts", () => {
    const org = freshOrg();
    const id = capture(org, "wombat merged away");
    activeDbFor(org)
      .prepare(`UPDATE thoughts SET visibility = 'merged_into:thg_other' WHERE id = ?`)
      .run(id);
    const hits = searchThoughts({
      orgId: org,
      projectId: "proj_c",
      query: "wombat",
      includeArchived: true,
    });
    expect(hits).toHaveLength(0);
  });

  test("unarchive restores visibility and resets the recall clock so the next run keeps it", () => {
    const org = freshOrg();
    const id = capture(org, "bring me back");
    const future = nowSec() + 120 * DAY;
    runThoughtConsolidation({ org_id: org, now_sec: future });
    expect(visibilityOf(org, id)).toBe("archived");

    const res = unarchiveThoughts({ org_id: org, ids: [id, "thg_missing"], now_sec: future });
    expect(res.restored).toEqual([id]);
    expect(res.not_archived).toEqual(["thg_missing"]);
    expect(visibilityOf(org, id)).toBe("active");

    const next = runThoughtConsolidation({ org_id: org, now_sec: future + DAY });
    expect(next.archived_stale).toEqual([]);
    expect(visibilityOf(org, id)).toBe("active");
  });

  test("an unarchived thought is pinned: neither staleness nor supersedes re-archives it", () => {
    const org = freshOrg();
    const oldT = capture(org, "old approach");
    const newT = capture(org, "new approach");
    addThoughtRef({ org_id: org, from_thought_id: newT, to_thought_id: oldT, relation: "supersedes" });
    runThoughtConsolidation({ org_id: org, now_sec: nowSec() });
    expect(visibilityOf(org, oldT)).toBe("archived");

    unarchiveThoughts({ org_id: org, ids: [oldT] });
    const res = runThoughtConsolidation({ org_id: org, now_sec: nowSec() + 400 * DAY });
    expect(res.archived_superseded).toEqual([]);
    expect(res.archived_stale).not.toContain(oldT);
    expect(res.protected.pinned).toBe(1);
    expect(visibilityOf(org, oldT)).toBe("active");
  });

  test("unarchive with pin=false restores but lets the thought decay again later", () => {
    const org = freshOrg();
    const id = capture(org, "temporary revival");
    const t1 = nowSec() + 120 * DAY;
    runThoughtConsolidation({ org_id: org, now_sec: t1 });
    unarchiveThoughts({ org_id: org, ids: [id], now_sec: t1, pin: false });
    expect(runThoughtConsolidation({ org_id: org, now_sec: t1 + 30 * DAY }).archived_stale).toEqual([]);
    expect(runThoughtConsolidation({ org_id: org, now_sec: t1 + 100 * DAY }).archived_stale).toEqual([id]);
  });

  test("unarchive leaves merged thoughts alone", () => {
    const org = freshOrg();
    const id = capture(org, "merged");
    activeDbFor(org)
      .prepare(`UPDATE thoughts SET visibility = 'merged_into:thg_z' WHERE id = ?`)
      .run(id);
    const res = unarchiveThoughts({ org_id: org, ids: [id] });
    expect(res.restored).toEqual([]);
    expect(visibilityOf(org, id)).toBe("merged_into:thg_z");
  });
});
