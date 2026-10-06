import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { nanoid } from "nanoid";
import { upsertLoopConfig } from "@nosleep/shared";
import { resolveLoopDecision } from "../orchestrator/loop-decision.js";
import type { SessionManager } from "../orchestrator/session-manager.js";
import type { SupervisionLoop } from "../orchestrator/supervision-loop.js";
import type { BudgetPacer } from "../budget/budget-pacer.js";

const launchSchema = z.object({
  projectId: z.string(),
  goal: z.string().min(10),
  acceptanceCriteria: z.array(z.string()).default([]),
  model: z.string().optional(),
  maxBudgetUsd: z.number().optional(),
  permissionMode: z.enum(["default", "plan", "auto", "acceptEdits", "supervised"]).optional(),
  strategyNodeId: z.string().optional(),
});

const interventionSchema = z.object({
  action: z.enum(["stop", "redirect"]),
  message: z.string().optional(),
});

const respondSchema = z.object({
  message: z.string().min(1),
  escalationId: z.string().optional(),
});

export function registerSessionRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
  sessionManager: SessionManager,
  supervision: SupervisionLoop,
  pacer?: BudgetPacer,
): void {
  // Get pending escalations across all sessions (must be before :id routes)
  fastify.get("/api/sessions/escalations", async (request) => {
    const { orgId } = request.query as { orgId?: string };
    const escalations = supervision.eventStore.getPendingEscalations(orgId);
    return { success: true, data: escalations };
  });

  // List all sessions, optionally filtered by org
  fastify.get("/api/sessions", async (request) => {
    const { orgId, status } = request.query as { orgId?: string; status?: string };

    // Phase 22-B — include the assigned strategy node title (LEFT JOIN
    // — most sessions don't carry one). Dashboard / mobile / brain graph
    // can show "this session is on: X" without a second round-trip.
    let sql = `
      SELECT s.*, p.name as project_name, o.name as org_name, o.slug as org_slug, o.color as org_color,
        sn.title as strategy_node_title,
        CASE WHEN s.status = 'running' AND s.last_activity_at IS NOT NULL
          THEN CAST((julianday('now') - julianday(s.last_activity_at)) * 86400 AS INTEGER)
          ELSE NULL END as idle_seconds
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      JOIN organizations o ON s.org_id = o.id
      LEFT JOIN strategy_nodes sn ON sn.id = s.strategy_node_id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (orgId) {
      // Direct filter on sessions.org_id — no JOIN traversal needed
      sql += ` AND s.org_id = ?`;
      params.push(orgId);
    }
    if (status) {
      sql += ` AND s.status = ?`;
      params.push(status);
    }

    // Live sessions first, then by recency of ACTIVITY (not start time — a
    // long-lived CLI session started weeks ago must not fall out of the
    // 100-row window while it is actively working; that hid every live
    // session older than the 100 most recently STARTED rows).
    sql += `
      ORDER BY (s.status IN ('starting', 'running', 'idle', 'waiting_input', 'paused')) DESC,
        s.last_activity_at DESC
      LIMIT 100`;

    const rows = db.prepare(sql).all(...params);
    return { success: true, data: rows };
  });

  // Get a single session
  fastify.get("/api/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    const row = db.prepare(`
      SELECT s.*, p.name as project_name, p.org_id, o.name as org_name, o.slug as org_slug, o.color as org_color
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      JOIN organizations o ON p.org_id = o.id
      WHERE s.id = ?
    `).get(id);

    if (!row) {
      return { success: false, error: "Session not found" };
    }

    // Include goal info
    const goal = db.prepare(`
      SELECT * FROM goals WHERE session_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(id);

    return { success: true, data: { ...row as object, goal } };
  });

  // Auto-register a manual CLI session (called by hooks when no session ID exists).
  //
  // BUG FIX: previously deduped by (project_id + 30-min window), which meant
  // multiple concurrent Claude Code sessions in the same folder collapsed onto
  // a single NoSleep row and only one showed in the dashboard. Now dedupes by
  // claudeSessionId (the Claude Code session_id from hook payloads). Each CC
  // session gets its own NoSleep row.
  fastify.post("/api/sessions/register", async (request, reply) => {
    const schema = z.object({
      orgId: z.string(),
      projectPath: z.string(),
      // Claude Code's session_id from hook payloads. Optional so older hook
      // scripts keep working — but new dedup keys off this when present.
      claudeSessionId: z.string().optional(),
      // Phase 22-B — runtime cwd from hookData. Used to detect worktrees:
      // when projectPath doesn't match any project AND cwd is inside a
      // git worktree, we resolve to the canonical repo path and pin the
      // worktree separately on the session row.
      cwd: z.string().optional(),
      // Which coding agent CLI registered the session. Claude Code hooks omit
      // it (default "claude"); the OpenCode plugin sends "opencode" and its
      // OpenCode sessionID in claudeSessionId (the same per-CLI-session
      // identity key — one NoSleep row per agent session).
      agent: z.enum(["claude", "opencode"]).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    const { orgId, projectPath, claudeSessionId, cwd, agent = "claude" } = parsed.data;

    type ProjectRow = { id: string; account_id: string; name: string; org_id: string };

    // Look up by path, PREFERRING the payload org but falling back to any org
    // with that path. A truly-global hook (installed in ~/.claude/settings.json)
    // bakes a default org, so a session in e.g. a work-org project folder would
    // post org_personal; resolving by path lets us attribute it to the
    // project's TRUE org (project.org_id is authoritative for the session).
    const lookupProject = (path: string): ProjectRow | undefined => {
      const exact = db
        .prepare(`SELECT p.id, p.account_id, p.name, p.org_id FROM projects p WHERE p.org_id = ? AND p.path = ?`)
        .get(orgId, path) as ProjectRow | undefined;
      if (exact) return exact;
      return db
        .prepare(`SELECT p.id, p.account_id, p.name, p.org_id FROM projects p WHERE p.path = ? LIMIT 1`)
        .get(path) as ProjectRow | undefined;
    };

    // Find-or-create a per-org "Ad-hoc sessions" catch-all so a session in an
    // unregistered folder is still TRACKED (visible) instead of 404'd into
    // invisibility. The real cwd is stored on the session's worktree_path. One
    // catch-all per org keeps the project list from filling with random dirs.
    const findOrCreateAdhocProject = (forOrg: string): ProjectRow | undefined => {
      const adhocPath = `__adhoc__/${forOrg}`;
      const existing = db
        .prepare(`SELECT id, account_id, name, org_id FROM projects WHERE org_id = ? AND path = ?`)
        .get(forOrg, adhocPath) as ProjectRow | undefined;
      if (existing) return existing;
      const account = db
        .prepare(`SELECT id FROM accounts WHERE org_id = ? ORDER BY id LIMIT 1`)
        .get(forOrg) as { id: string } | undefined;
      if (!account) return undefined; // no account to attach to — can't provision
      const id = `proj_adhoc_${forOrg}`;
      db.prepare(
        `INSERT OR IGNORE INTO projects (id, org_id, name, path, account_id, autonomy_level) VALUES (?, ?, 'Ad-hoc sessions', ?, ?, 'manual')`,
      ).run(id, forOrg, adhocPath, account.id);
      return db
        .prepare(`SELECT id, account_id, name, org_id FROM projects WHERE id = ?`)
        .get(id) as ProjectRow | undefined;
    };

    let project = lookupProject(projectPath);
    let resolvedWorktreePath: string | null = null;

    // Phase 22-B — worktree resolution. If the projectPath doesn't match a
    // project AND the path is a git worktree, fall back to the canonical
    // repo via `git rev-parse --git-common-dir`. The common-dir parent is
    // the canonical project; we project_id against that and store the
    // worktree path so the dashboard can show it.
    if (!project) {
      const probePath = cwd ?? projectPath;
      try {
        // Lazy import — no point pulling node:child_process if every
        // session registers cleanly via the fast path.
        const { execFileSync } = await import("node:child_process");
        const commonDir = execFileSync("git", ["-C", probePath, "rev-parse", "--git-common-dir"], {
          encoding: "utf8",
          timeout: 2000,
        }).trim();
        // common-dir is .git or absolute path to <canonical>/.git
        const path = await import("node:path");
        const absCommonDir = path.isAbsolute(commonDir)
          ? commonDir
          : path.join(probePath, commonDir);
        const canonical = path.dirname(absCommonDir);
        project = lookupProject(canonical);
        if (project) {
          resolvedWorktreePath = probePath;
          fastify.log.info(
            { worktree: probePath, canonical, project: project.name },
            "register: resolved worktree to canonical project",
          );
        }
      } catch {
        // git not available or not a worktree — fall through to 404
      }
    }

    if (!project) {
      // Unknown folder — auto-provision into the org's Ad-hoc catch-all so the
      // session is visible rather than silently dropped. Falls back to 404 only
      // if the org has no account to attach to.
      project = findOrCreateAdhocProject(orgId);
      if (!project) {
        return reply.status(404).send({ success: false, error: "No project found and no account to auto-provision under for this org" });
      }
      // The real working dir lives on the session row for visibility.
      resolvedWorktreePath = cwd ?? projectPath;
    }

    // A session registering here is live work in this project — if the
    // project was archived (active=0) it is factually active again. Without
    // this, the stale-session sweep force-stops its sessions every tick and
    // the dashboard hides the project while the user is working in it.
    const reactivated = db
      .prepare(`UPDATE projects SET active = 1 WHERE id = ? AND active = 0`)
      .run(project.id);
    if (reactivated.changes > 0) {
      fastify.log.info(
        { project: project.name },
        "register: reactivated archived project — live session registered in it",
      );
    }

    // Resurrect a manual row the stale sweep (or a turn-end stop) parked in a
    // terminal state while the Claude Code session is still alive. The hook
    // calling us IS proof of life; without this the row stays 'stopped'
    // forever and the dashboard never shows the session again.
    const resurrect = db.prepare(`
      UPDATE sessions SET status = 'running', ended_at = NULL
      WHERE id = ? AND id LIKE 'manual_%'
      AND status IN ('stopped', 'idle', 'completed', 'failed')
    `);

    // Primary dedup: same Claude Code session id → reuse the existing
    // NoSleep row. This is the correct identity — one NoSleep session per
    // Claude Code session, regardless of project folder collisions.
    if (claudeSessionId) {
      const byClaudeId = db.prepare(`
        SELECT id FROM sessions
        WHERE claude_session_id = ? AND project_id = ?
        LIMIT 1
      `).get(claudeSessionId, project.id) as { id: string } | undefined;

      if (byClaudeId) {
        db.prepare(
          `UPDATE sessions SET last_activity_at = datetime('now') WHERE id = ?`,
        ).run(byClaudeId.id);
        resurrect.run(byClaudeId.id);
        return reply.status(200).send({
          success: true,
          data: {
            sessionId: byClaudeId.id,
            projectId: project.id,
            projectName: project.name,
            reused: true,
          },
        });
      }

      // BUG FIX (subagent spam): when the Task tool spawns a subagent,
      // that subagent has its own claude_session_id and registers as a
      // brand-new session. With heavy multi-agent workflows we saw 1100+
      // ghost manual_* rows that never produced a tool_use event.
      // Strategy: if this project already has a running manual_ session
      // and any other session for this project has fired a tool_use in
      // the last 60s, the new caller is almost certainly a subagent of
      // that parent. Attach hooks to the parent's row.
      // 60s is a wide-enough window to cover subagent startup latency
      // (which can pause 10-30s for tool-result gathering) without
      // collapsing two genuinely-concurrent CC instances together —
      // that scenario is rare and recoverable.
      const activeParent = db.prepare(`
        SELECT id FROM sessions
        WHERE project_id = ?
          AND status = 'running'
          AND id LIKE 'manual_%'
          AND last_activity_at > datetime('now', '-60 seconds')
        ORDER BY last_activity_at DESC
        LIMIT 1
      `).get(project.id) as { id: string } | undefined;

      if (activeParent) {
        db.prepare(
          `UPDATE sessions SET last_activity_at = datetime('now') WHERE id = ?`,
        ).run(activeParent.id);
        return reply.status(200).send({
          success: true,
          data: {
            sessionId: activeParent.id,
            projectId: project.id,
            projectName: project.name,
            reused: true,
            subagentOf: activeParent.id,
          },
        });
      }
    }

    // Fallback dedup (only when no claudeSessionId provided — legacy hook
    // scripts) — reuse a recent manual session for this project. Same
    // 30-minute window as before, kept narrow so it only catches "same
    // shell session calling register twice" rather than "two distinct
    // Claude Codes in the same folder".
    if (!claudeSessionId) {
      const existing = db.prepare(`
        SELECT id FROM sessions
        WHERE project_id = ? AND status = 'running' AND id LIKE 'manual_%'
        AND claude_session_id IS NULL
        AND last_activity_at > datetime('now', '-30 minutes')
        ORDER BY last_activity_at DESC LIMIT 1
      `).get(project.id) as { id: string } | undefined;

      if (existing) {
        db.prepare(
          `UPDATE sessions SET last_activity_at = datetime('now') WHERE id = ?`,
        ).run(existing.id);
        return reply.status(200).send({
          success: true,
          data: {
            sessionId: existing.id,
            projectId: project.id,
            projectName: project.name,
            reused: true,
          },
        });
      }
    }

    const sessionId = `manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`
      INSERT INTO sessions (id, project_id, org_id, account_id, pid, status, goal_text, goal_hash, claude_session_id, worktree_path)
      VALUES (?, ?, ?, ?, NULL, 'running', ?, 'manual', ?, ?)
    `).run(
      sessionId,
      project.id,
      project.org_id, // authoritative org from the resolved project, not the payload
      project.account_id,
      agent === "opencode" ? "Manual OpenCode session" : "Manual CLI session",
      claudeSessionId ?? null,
      resolvedWorktreePath ?? cwd ?? null,
    );

    // Log the auto-registration
    db.prepare(`INSERT INTO session_events (session_id, event_type, payload) VALUES (?, 'auto_registered', ?)`)
      .run(
        sessionId,
        JSON.stringify({
          projectName: project.name,
          orgId,
          projectPath,
          worktreePath: resolvedWorktreePath,
          cwd: cwd ?? null,
          claudeSessionId: claudeSessionId ?? null,
          agent,
        }),
      );

    fastify.log.info(
      `Auto-registered manual session ${sessionId} for ${project.name}${claudeSessionId ? ` (cc=${claudeSessionId.slice(0, 8)}…)` : ""}${resolvedWorktreePath ? ` worktree=${resolvedWorktreePath}` : ""}`,
    );

    return reply.status(201).send({
      success: true,
      data: {
        sessionId,
        projectId: project.id,
        projectName: project.name,
        worktreePath: resolvedWorktreePath,
      },
    });
  });

  // Launch a new session
  fastify.post("/api/sessions", async (request, reply) => {
    const parsed = launchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    const { projectId, goal, acceptanceCriteria, model, maxBudgetUsd, permissionMode, strategyNodeId } = parsed.data;

    // Look up the project to get org, account, and path
    const project = db.prepare(`
      SELECT p.id, p.org_id, p.account_id, p.path, p.autonomy_level, p.continue_session
      FROM projects p WHERE p.id = ?
    `).get(projectId) as {
      id: string; org_id: string; account_id: string; path: string;
      autonomy_level: "full" | "supervised" | "manual"; continue_session: number;
    } | undefined;

    if (!project) {
      return reply.status(404).send({ success: false, error: "Project not found" });
    }

    // Check if there's an ACTIVE manual session (tool call in last 2 minutes) — inject via message queue
    const activeManual = db.prepare(`
      SELECT id FROM sessions
      WHERE project_id = ? AND status = 'running' AND id LIKE 'manual_%'
      AND last_activity_at > datetime('now', '-2 minutes')
      ORDER BY last_activity_at DESC LIMIT 1
    `).get(projectId) as { id: string } | undefined;

    if (activeManual) {
      // Session is actively working — inject the task, it'll be delivered on next tool call (seconds away)
      const criteriaText = acceptanceCriteria.length > 0
        ? "\n\nAcceptance Criteria:\n" + acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
        : "";
      const nodeRef = strategyNodeId
        ? `\n\nCall nosleep(action="strategy_update", params={nodeId:"${strategyNodeId}", status:"in_progress"}) to mark this task as started.`
        : "";

      supervision.messageQueue.push(activeManual.id,
        `NEW TASK ASSIGNED:\n\n${goal}${criteriaText}${nodeRef}\n\nDrop your current work and start this task now.`
      );

      db.prepare(`UPDATE sessions SET goal_text = ?, last_activity_at = datetime('now') WHERE id = ?`)
        .run(goal.slice(0, 200), activeManual.id);

      return reply.status(200).send({
        success: true,
        data: { sessionId: activeManual.id, injected: true },
      });
    }

    // If there's an IDLE manual session (exists but chilling) — spawn a parallel NoSleep session.
    // The idle session gets a courtesy notification when it wakes up.
    const idleManual = db.prepare(`
      SELECT id FROM sessions
      WHERE project_id = ? AND status = 'running' AND id LIKE 'manual_%'
      AND last_activity_at <= datetime('now', '-2 minutes')
      ORDER BY last_activity_at DESC LIMIT 1
    `).get(projectId) as { id: string } | undefined;

    if (idleManual) {
      // Queue a notification for when the idle session wakes up
      supervision.messageQueue.push(idleManual.id,
        `FYI: A parallel NoSleep session was launched for this project while you were idle. Task: "${goal.slice(0, 100)}". Coordinate via nosleep(action="session_peers") to avoid conflicts.`
      );
    }

    // Check pacing before launching
    if (pacer) {
      const estimatedCost = pacer.estimateSessionCost(project.account_id);
      const pacingCheck = pacer.canLaunchSession(project.account_id, estimatedCost);
      if (!pacingCheck.allowed) {
        const pacingStatus = pacer.getPacingStatus(project.account_id);
        return reply.status(429).send({
          success: false,
          error: pacingCheck.reason ?? "Budget pacing limit reached",
          suggestion: pacingCheck.suggestion,
          pacingMode: pacingCheck.pacingMode,
          pacing: pacingStatus,
        });
      }
    }

    try {
      // Auto-enable loop for server-launched sessions (phone, scheduler)
      const { writeFileSync: fsWrite, mkdirSync: fsMkdir } = await import("node:fs");
      const { join: pathJoin } = await import("node:path");
      try {
        fsMkdir(pathJoin(project.path, ".claude"), { recursive: true });
        fsWrite(pathJoin(project.path, ".claude", ".nosleep-loop-active"), "active");
      } catch {}

      const sessionId = sessionManager.launch({
        projectId,
        orgId: project.org_id,
        accountId: project.account_id,
        cwd: project.path,
        goal,
        acceptanceCriteria,
        model,
        maxBudgetUsd,
        permissionMode,
        strategyNodeId,
        continueSession: project.continue_session === 1,
        autonomyLevel: project.autonomy_level,
      });

      return reply.status(201).send({ success: true, data: { sessionId } });
    } catch (err) {
      const message = (err as Error).message;
      if (message.startsWith("Session blocked by budget pacer:")) {
        const pacingStatus = pacer ? pacer.getPacingStatus(project.account_id) : null;
        return reply.status(429).send({
          success: false,
          error: message,
          pacing: pacingStatus,
        });
      }
      throw err;
    }
  });

  // Fork a failed/completed session into a new attempt with failure context.
  // The new session keeps the same goal and acceptance criteria but prepends
  // a "Previous attempt failed because…" preamble so the agent can avoid the
  // same mistake. Tracks the parent → child relationship via parent_session_id.
  fastify.post("/api/sessions/:id/fork", async (request, reply) => {
    const { id } = request.params as { id: string };
    const forkSchema = z.object({
      failureMode: z.string().min(1).max(64).optional(),
      failureSummary: z.string().min(1).max(4000).optional(),
      additionalContext: z.string().max(4000).optional(),
    });
    const parsed = forkSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    // Look up parent session
    const parent = db.prepare(`
      SELECT s.id, s.project_id, s.org_id, s.account_id, s.goal_text,
             g.acceptance_criteria, p.path as project_path, p.autonomy_level
      FROM sessions s
      LEFT JOIN goals g ON g.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      WHERE s.id = ?
      ORDER BY g.created_at DESC
      LIMIT 1
    `).get(id) as {
      id: string;
      project_id: string;
      org_id: string;
      account_id: string;
      goal_text: string;
      acceptance_criteria: string | null;
      project_path: string;
      autonomy_level: string;
    } | undefined;

    if (!parent) {
      return reply.status(404).send({ success: false, error: "Parent session not found" });
    }

    // Persist the failure context on the parent before forking — avoids losing it
    if (parsed.data.failureMode || parsed.data.failureSummary) {
      db.prepare(`UPDATE sessions SET failure_mode = ?, failure_summary = ? WHERE id = ?`).run(
        parsed.data.failureMode ?? null,
        parsed.data.failureSummary ?? null,
        id,
      );
    }

    // Build the augmented goal with failure context prepended
    const sections: string[] = [];
    sections.push("# RETRY — PREVIOUS ATTEMPT FAILED");
    if (parsed.data.failureMode) {
      sections.push(`Failure mode: ${parsed.data.failureMode}`);
    }
    if (parsed.data.failureSummary) {
      sections.push(`Summary: ${parsed.data.failureSummary}`);
    }
    if (parsed.data.additionalContext) {
      sections.push("");
      sections.push("Additional context:");
      sections.push(parsed.data.additionalContext);
    }
    sections.push("");
    sections.push("# ORIGINAL GOAL");
    sections.push(parent.goal_text);
    sections.push("");
    sections.push("Do NOT repeat the previous failure mode. Address the root cause.");
    const augmentedGoal = sections.join("\n");

    let criteria: string[] = [];
    try {
      const parsedCriteria = JSON.parse(parent.acceptance_criteria ?? "[]");
      if (Array.isArray(parsedCriteria)) {
        criteria = parsedCriteria
          .map((c: unknown) => (typeof c === "string" ? c : (c as { description?: string })?.description ?? ""))
          .filter((c) => c.length > 0);
      }
    } catch {
      // empty criteria is fine
    }

    let childSessionId: string;
    try {
      childSessionId = sessionManager.launch({
        projectId: parent.project_id,
        orgId: parent.org_id,
        accountId: parent.account_id,
        cwd: parent.project_path,
        goal: augmentedGoal,
        acceptanceCriteria: criteria,
        autonomyLevel: parent.autonomy_level as "full" | "supervised" | "manual",
        permissionMode: "auto",
        noRetry: false,
      });
    } catch (e) {
      return reply.status(503).send({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Link the child back to its parent
    db.prepare(`UPDATE sessions SET parent_session_id = ? WHERE id = ?`).run(id, childSessionId);

    return reply.status(201).send({
      success: true,
      data: {
        parentSessionId: id,
        childSessionId,
        goalLength: augmentedGoal.length,
      },
    });
  });

  // Get the full retry chain for a session (parent → child → grandchild)
  fastify.get("/api/sessions/:id/chain", async (request) => {
    const { id } = request.params as { id: string };

    // Walk up to root
    const ancestors: Array<{ id: string; status: string; failure_mode: string | null; failure_summary: string | null; started_at: string }> = [];
    let cursor: string | null = id;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const row = db.prepare(`
        SELECT id, status, failure_mode, failure_summary, parent_session_id, started_at
        FROM sessions WHERE id = ?
      `).get(cursor) as { id: string; status: string; failure_mode: string | null; failure_summary: string | null; parent_session_id: string | null; started_at: string } | undefined;
      if (!row) break;
      ancestors.unshift({
        id: row.id,
        status: row.status,
        failure_mode: row.failure_mode,
        failure_summary: row.failure_summary,
        started_at: row.started_at,
      });
      cursor = row.parent_session_id;
    }

    // Walk down to descendants
    const descendants: Array<{ id: string; status: string; started_at: string }> = [];
    let frontier: string[] = [id];
    const seenDown = new Set<string>([id]);
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const parentId of frontier) {
        const children = db.prepare(`
          SELECT id, status, started_at FROM sessions WHERE parent_session_id = ?
          ORDER BY started_at ASC
        `).all(parentId) as Array<{ id: string; status: string; started_at: string }>;
        for (const c of children) {
          if (seenDown.has(c.id)) continue;
          seenDown.add(c.id);
          descendants.push(c);
          next.push(c.id);
        }
      }
      frontier = next;
    }

    return { success: true, data: { ancestors, descendants } };
  });

  // Intervene in a session (stop, redirect)
  fastify.post("/api/sessions/:id/intervene", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = interventionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    const { action, message } = parsed.data;

    if (action === "stop") {
      sessionManager.stop(id);
      return { success: true, data: { action: "stopped" } };
    }

    if (action === "redirect") {
      if (!message) {
        return reply.status(400).send({ success: false, error: "redirect requires a message" });
      }
      // Wrapped sessions: inject straight into the live process stdin.
      const sent = sessionManager.redirect(id, message);
      if (sent) {
        return { success: true, data: { action: "redirected", via: "process" } };
      }
      // Connected (non-wrapped) sessions have no process to write to — queue
      // the message instead. The session's Stop hook drains it between turns
      // (/api/sessions/:id/drain) and injects it. This is what makes
      // dashboard/mobile steering work for sessions NoSleep didn't spawn.
      const row = db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(id) as { id: string } | undefined;
      if (!row) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }
      supervision.messageQueue.push(id, message);
      return { success: true, data: { action: "queued", via: "steer_queue" } };
    }

    return reply.status(400).send({ success: false, error: "Unknown action" });
  });

  // Human response to an escalated question
  fastify.post("/api/sessions/:id/respond", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = respondSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    const sent = supervision.respondToEscalation(id, parsed.data.message, parsed.data.escalationId);
    if (!sent) {
      return reply.status(404).send({ success: false, error: "Session not found or not waiting" });
    }

    // Resume the session status from waiting_input back to running
    sessionManager.updateStatusExternal(id, "running");

    return { success: true, data: { action: "responded" } };
  });

  // Decide what to do after a session exits (uses Haiku for intelligent routing)
  fastify.post("/api/sessions/:id/decide-next", async (request) => {
    const { id } = request.params as { id: string };
    const { stopReason, lastOutput } = request.body as { stopReason?: string; lastOutput?: string };

    const session = db.prepare(`
      SELECT s.project_id, s.goal_text, p.org_id, p.name as project_name
      FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = ?
    `).get(id) as { project_id: string; goal_text: string; org_id: string; project_name: string } | undefined;

    if (!session) return { success: true, data: { action: "stop", reason: "Session not found" } };

    // Budget check — don't loop if budget is exhausted
    const account = db.prepare(`
      SELECT a.id FROM accounts a WHERE a.org_id = ?
    `).get(session.org_id) as { id: string } | undefined;

    if (account && pacer) {
      const cooldownMs = pacer.getAutoAdvanceCooldownMs(account.id);
      if (cooldownMs === -1) {
        // Make the sleep VISIBLE: a budget-stopped loop previously declined
        // silently and looked broken ("loop enabled but nothing happens").
        const existing = db.prepare(
          `SELECT 1 FROM alerts WHERE type = 'loop_budget_stopped' AND acknowledged = 0 AND created_at > date('now') LIMIT 1`,
        ).get();
        if (!existing) {
          db.prepare(
            `INSERT INTO alerts (org_id, project_id, type, severity, message) VALUES (?, ?, 'loop_budget_stopped', 'warning', ?)`,
          ).run(session.org_id, session.project_id,
            `Autonomous loop for ${session.project_name} is SLEEPING: daily token budget exceeded. It resumes when the daily window resets (midnight) or the account's daily_token_limit is raised.`);
        }
        return { success: true, data: { action: "stop", reason: "Daily token budget exceeded (>200%). Stopping to preserve budget." } };
      }
      // If cooldown > 0, include it so the hook can decide whether to wait or stop
      if (cooldownMs > 0) {
        const burnRate = pacer.getBurnRatePct(account.id);
        const pacingMode = pacer.getPacingMode(account.id);
        // In slow/critical mode, stop looping and let the human decide
        if (pacingMode === "critical") {
          return { success: true, data: { action: "stop", reason: `Budget critical (${Math.round(burnRate)}% burn rate). Stopping auto-loop.` } };
        }
        // In cautious/slow, add a note but continue
      }
    }

    // Delegate the mode/content/branch + no-progress + auto-stop logic to the
    // loop brain (honours the AI-controllable project_loops config).
    const decision = resolveLoopDecision(db, session.project_id, { stopReason });

    // Pin the assigned task on the session row so the dashboard / mobile /
    // brain graph can show "this session is working on X".
    if (decision.action === "next_task" && decision.nextTask) {
      db.prepare(`UPDATE sessions SET strategy_node_id = ?, last_activity_at = datetime('now') WHERE id = ?`)
        .run(decision.nextTask.id, id);
    }

    return { success: true, data: { ...decision, projectName: session.project_name } };
  });

  // Time-based loop hand-off. The interactive Stop hook calls this when the
  // loop is configured with a delay (`/nosleep-go 15m`): instead of blocking
  // the current session to continue immediately (the old, aggressive
  // behaviour), it lets the session end and schedules a ONE-SHOT wake N
  // minutes out. The task-scheduler fires the wake during dead time and
  // launches a fresh session pointed at the next strategy-tree task. This
  // matches Claude-native `/loop Nm` semantics — wait N, then run next —
  // but durably and server-side, surviving the session ending.
  fastify.post("/api/sessions/:id/schedule-wake", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { delayMinutes?: number };
    const delay = Math.max(1, Math.min(Math.floor(body.delayMinutes ?? 0), 7 * 24 * 60));
    if (!Number.isFinite(delay) || delay < 1) {
      return reply.status(400).send({ success: false, error: "delayMinutes must be >= 1" });
    }

    const session = db.prepare(
      `SELECT s.project_id, p.org_id, p.name AS project_name FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = ?`,
    ).get(id) as { project_id: string; org_id: string; project_name: string } | undefined;
    if (!session) {
      return reply.status(404).send({ success: false, error: "Session not found" });
    }

    const nextRun = new Date(Date.now() + delay * 60_000).toISOString();

    // Collapse duplicate pending wakes for the same project — keep one.
    db.prepare(
      `DELETE FROM scheduled_tasks WHERE project_id = ? AND oneshot = 1 AND strategy_mode = 'next_actionable' AND enabled = 1`,
    ).run(session.project_id);

    const wakeId = nanoid();
    db.prepare(
      `INSERT INTO scheduled_tasks
         (id, project_id, org_id, name, cron_hour, cron_minute, days_of_week,
          goal_template, task_type, enabled, next_run_at,
          mode, interval_minutes, oneshot, strategy_mode)
       VALUES (?, ?, ?, ?, 0, 0, '0,1,2,3,4,5,6', '', 'loop', 1, ?, 'interval', ?, 1, 'next_actionable')`,
    ).run(
      wakeId,
      session.project_id,
      session.org_id,
      `Loop wake (+${delay}m)`,
      nextRun,
      delay,
    );

    return { success: true, data: { wakeId, nextRunAt: nextRun, delayMinutes: delay } };
  });

  // Drain queued messages for a session (used by nosleep CLI wrapper for stdin injection)
  fastify.post("/api/sessions/:id/drain", async (request) => {
    const { id } = request.params as { id: string };
    const msg = supervision.messageQueue.drain(id);
    return { success: true, data: { message: msg } };
  });

  // Get full conversation output for a wrapped session
  fastify.get("/api/sessions/:id/terminal", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { tail } = request.query as { tail?: string };
    const tailBytes = Math.min(parseInt(tail ?? "20000", 10) || 20000, 100000);

    const session = db.prepare(`
      SELECT p.path, p.name as project_name, s.status, s.goal_text
      FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = ?
    `).get(id) as { path: string; project_name: string; status: string; goal_text: string } | undefined;

    if (!session) {
      return reply.status(404).send({ success: false, error: "Session not found" });
    }

    const { existsSync, openSync, readSync, closeSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const logPath = join(session.path, ".claude", ".nosleep-inject.log");

    if (!existsSync(logPath)) {
      // Fallback: show session events if no log file
      const events = db.prepare(`
        SELECT event_type, payload, created_at FROM session_events
        WHERE session_id = ? ORDER BY created_at DESC LIMIT 50
      `).all(id) as Array<{ event_type: string; payload: string; created_at: string }>;

      const lines = [`── ${session.project_name} (${session.status}) ──`, `Goal: ${session.goal_text.slice(0, 150)}`, ``];
      for (const evt of events.reverse()) {
        let p: Record<string, unknown> = {};
        try { p = JSON.parse(evt.payload); } catch {}
        const t = evt.created_at.split(" ")[1] ?? "";
        lines.push(`${t} [${evt.event_type}] ${p.tool ?? p.action ?? ""}`);
      }
      return { success: true, data: { output: lines.join("\n"), size: lines.length, available: true } };
    }

    const stat = statSync(logPath);
    const readStart = Math.max(0, stat.size - tailBytes);
    const readSize = Math.min(tailBytes, stat.size);
    const buf = Buffer.alloc(readSize);
    const fd = openSync(logPath, "r");
    readSync(fd, buf, 0, readSize, readStart);
    closeSync(fd);

    return { success: true, data: { output: buf.toString("utf-8"), size: stat.size, available: true } };
  });

  // Send input to a wrapped session (writes to the inject pipe)
  fastify.post("/api/sessions/:id/input", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { text } = request.body as { text?: string };

    if (!text) {
      return reply.status(400).send({ success: false, error: "text is required" });
    }

    const session = db.prepare(`
      SELECT p.path FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = ?
    `).get(id) as { path: string } | undefined;

    if (!session) {
      return reply.status(404).send({ success: false, error: "Session not found" });
    }

    const { existsSync, appendFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const pipePath = join(session.path, ".claude", ".nosleep-inject");

    if (!existsSync(pipePath)) {
      return reply.status(404).send({ success: false, error: "Session not wrapped with nosleep CLI (no inject pipe)" });
    }

    appendFileSync(pipePath, text + "\n");
    return { success: true, data: { sent: true } };
  });

  // Remote loop control (from phone) — enable/disable auto-loop for a project
  fastify.post("/api/projects/:id/loop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { enabled } = request.body as { enabled?: boolean };

    const project = db.prepare(`SELECT path FROM projects WHERE id = ?`).get(id) as { path: string } | undefined;
    if (!project) return reply.status(404).send({ success: false, error: "Project not found" });

    const { existsSync: fsExists, writeFileSync: fsWrite, unlinkSync: fsUnlink, mkdirSync: fsMkdir } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    const loopFile = pathJoin(project.path, ".claude", ".nosleep-loop-active");

    if (enabled) {
      try { fsMkdir(pathJoin(project.path, ".claude"), { recursive: true }); } catch {}
      fsWrite(loopFile, "active");
      // Source of truth for HOW the loop behaves lives in project_loops; the
      // file is just a legacy on/off hint for the Stop hook.
      upsertLoopConfig(db, id, { enabled: true });
      return { success: true, data: { loop: "enabled" } };
    } else {
      try { if (fsExists(loopFile)) fsUnlink(loopFile); } catch {}
      upsertLoopConfig(db, id, { enabled: false });
      return { success: true, data: { loop: "disabled" } };
    }
  });

  // Get loop status for a project. Source of truth is project_loops (the file
  // is only a legacy hint), so report the full config.
  fastify.get("/api/projects/:id/loop", async (request) => {
    const { id } = request.params as { id: string };
    const project = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(id) as { id: string } | undefined;
    if (!project) return { success: true, data: { loop: "unknown" } };

    const { getLoopConfig } = await import("@nosleep/shared");
    const c = getLoopConfig(db, id);
    return {
      success: true,
      data: {
        loop: c.enabled ? "enabled" : "disabled",
        mode: c.mode,
        intervalMinutes: c.interval_minutes,
        linkedNodeId: c.linked_node_id,
        hasContent: Boolean(c.content && c.content.trim()),
      },
    };
  });

  // Get event log for a session
  fastify.get("/api/sessions/:id/events", async (request) => {
    const { id } = request.params as { id: string };
    const { type, limit } = request.query as { type?: string; limit?: string };
    const parsedLimit = limit ? Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000) : 200;

    const validTypes = new Set([
      "tool_use", "text_output", "question_detected", "escalation_created",
      "escalation_resolved", "human_response", "auto_continued", "goal_injected",
      "drift_detected", "compaction_detected", "compaction_recovery",
      "validation_started", "validation_result", "retry_launched",
      "strategy_advanced", "status_change", "error",
    ]);

    if (type && validTypes.has(type)) {
      const events = supervision.eventStore.getByType(id, type as import("../events/session-event-store.js").SessionEventType, parsedLimit);
      return { success: true, data: events };
    }

    const events = supervision.eventStore.getBySession(id, parsedLimit);
    return { success: true, data: events };
  });
}
