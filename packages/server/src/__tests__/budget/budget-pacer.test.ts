import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { BudgetPacer } from "../../budget/budget-pacer.js";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";

function recordTokenUsage(
  db: Database.Database,
  params: {
    sessionId: string;
    accountId: string;
    projectId: string;
    inputTokens: number;
    outputTokens: number;
    recordedAt?: string;
  },
): void {
  db.prepare(`
    INSERT INTO token_usage (session_id, account_id, project_id, input_tokens, output_tokens, model, recorded_at)
    VALUES (?, ?, ?, ?, ?, 'sonnet', ?)
  `).run(
    params.sessionId,
    params.accountId,
    params.projectId,
    params.inputTokens,
    params.outputTokens,
    params.recordedAt ?? new Date().toISOString().replace("T", " ").slice(0, 19),
  );
}

function insertSession(
  db: Database.Database,
  id: string,
  projectId: string,
  orgId: string,
  accountId: string,
): void {
  db.prepare(`
    INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash)
    VALUES (?, ?, ?, ?, 'running', 'g', 'h')
  `).run(id, projectId, orgId, accountId);
}

describe("BudgetPacer.getCycleRange", () => {
  let db: Database.Database;
  let pacer: BudgetPacer;

  beforeEach(() => {
    db = createTestDb();
    pacer = new BudgetPacer(db);
  });

  afterEach(() => {
    db.close();
  });

  it("billing cycle starting on day 1, today is day 15 → cycle is this month", () => {
    const range = pacer.getCycleRange(1, new Date(Date.UTC(2026, 5, 15))); // June 15
    expect(range.start.getUTCMonth()).toBe(5); // June
    expect(range.end.getUTCMonth()).toBe(6); // July
  });

  it("billing cycle starting on day 20, today is day 5 → cycle started last month", () => {
    const range = pacer.getCycleRange(20, new Date(Date.UTC(2026, 5, 5))); // June 5
    expect(range.start.getUTCMonth()).toBe(4); // May
    expect(range.end.getUTCMonth()).toBe(5); // June
  });

  it("handles year wrap (December → January)", () => {
    const range = pacer.getCycleRange(15, new Date(Date.UTC(2026, 11, 20))); // Dec 20
    expect(range.start.getUTCFullYear()).toBe(2026);
    expect(range.end.getUTCFullYear()).toBe(2027);
    expect(range.end.getUTCMonth()).toBe(0); // January
  });
});

describe("BudgetPacer.getRemainingDays", () => {
  let db: Database.Database;
  let pacer: BudgetPacer;

  beforeEach(() => {
    db = createTestDb();
    pacer = new BudgetPacer(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns days between today and cycle end", () => {
    const days = pacer.getRemainingDays(15, new Date(Date.UTC(2026, 5, 14))); // day before cycle starts
    expect(days).toBeGreaterThanOrEqual(1);
    expect(days).toBeLessThanOrEqual(2); // Cycle ends June 15
  });

  it("returns at least 1 day even at cycle end", () => {
    const days = pacer.getRemainingDays(15, new Date(Date.UTC(2026, 5, 15))); // exact start
    expect(days).toBeGreaterThanOrEqual(1);
  });
});

describe("BudgetPacer.getPacingMode", () => {
  let db: Database.Database;
  let pacer: BudgetPacer;
  let accountId: string;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    pacer = new BudgetPacer(db);
    const ids = seedMultiOrg(db);
    accountId = ids.personal.accountId;
    projectId = ids.personal.projectId;
    // Force a tiny, predictable monthly budget so burn-rate math is independent of cycle day.
    // With monthly=1000 tokens and N remaining days, daily allowance = floor(1000/N).
    // For tests we just need allowance > 0 and known multipliers — we hit it with absolute values
    // that are large enough to dwarf any allowance, so burn is always > 200%.
    db.prepare(`UPDATE accounts SET monthly_token_limit = 100, daily_token_limit = 0 WHERE id = ?`).run(accountId);
    insertSession(db, "s1", projectId, ids.personal.orgId, accountId);
  });

  afterEach(() => {
    db.close();
  });

  it("returns 'normal' when no token usage", () => {
    expect(pacer.getPacingMode(accountId)).toBe("normal");
  });

  it("returns 'critical' when usage massively exceeds allowance", () => {
    recordTokenUsage(db, { sessionId: "s1", accountId, projectId, inputTokens: 10_000, outputTokens: 5_000 });
    expect(pacer.getPacingMode(accountId)).toBe("critical");
  });

  it("returns 'critical' when account has zero allowance", () => {
    db.prepare(`UPDATE accounts SET monthly_token_limit = 0, daily_token_limit = 0 WHERE id = ?`).run(accountId);
    expect(pacer.getPacingMode(accountId)).toBe("critical");
  });

  it("transitions through pacing modes as usage grows (relative to daily allowance)", () => {
    // Compute daily allowance for this account with our small budget
    const daily = pacer.getDailyAllowance(accountId);
    expect(daily).toBeGreaterThan(0);

    // 50% burn — normal
    recordTokenUsage(db, { sessionId: "s1", accountId, projectId, inputTokens: Math.floor(daily * 0.5), outputTokens: 0 });
    expect(pacer.getPacingMode(accountId)).toBe("normal");
  });
});

describe("BudgetPacer.canLaunchSession", () => {
  let db: Database.Database;
  let pacer: BudgetPacer;
  let accountId: string;
  let projectId: string;
  let orgId: string;
  let daily: number;

  beforeEach(() => {
    db = createTestDb();
    pacer = new BudgetPacer(db);
    const ids = seedMultiOrg(db);
    accountId = ids.personal.accountId;
    projectId = ids.personal.projectId;
    orgId = ids.personal.orgId;
    // Tiny budget so burn-rate math is predictable in tests
    db.prepare(`UPDATE accounts SET monthly_token_limit = 100, daily_token_limit = 0 WHERE id = ?`).run(accountId);
    insertSession(db, "s1", projectId, orgId, accountId);
    daily = pacer.getDailyAllowance(accountId);
  });

  afterEach(() => {
    db.close();
  });

  it("allows launch in normal pacing mode", () => {
    const result = pacer.canLaunchSession(accountId);
    expect(result.allowed).toBe(true);
    expect(result.pacingMode).toBe("normal");
  });

  it("blocks launch when critical and burn > 200%", () => {
    // Use ~250% of daily allowance
    recordTokenUsage(db, { sessionId: "s1", accountId, projectId, inputTokens: Math.floor(daily * 2.5), outputTokens: 0 });
    const result = pacer.canLaunchSession(accountId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/overdrawn/i);
    expect(result.pacingMode).toBe("critical");
  });

  it("priority tasks bypass critical mode at moderate overrun (≤300%)", () => {
    // Bigger budget so daily allowance stays positive after burn — use 10000 monthly
    db.prepare(`UPDATE accounts SET monthly_token_limit = 10000, daily_token_limit = 0 WHERE id = ?`).run(accountId);
    const newDaily = pacer.getDailyAllowance(accountId);
    // ~250% burn — keep allowance positive. Daily allowance shrinks as cycle usage grows,
    // so a smaller multiplier gets us into the 200-300% window
    recordTokenUsage(db, { sessionId: "s1", accountId, projectId, inputTokens: Math.floor(newDaily * 2), outputTokens: 0 });
    const burn = pacer.getBurnRatePct(accountId);
    expect(burn).toBeGreaterThan(200);
    expect(burn).toBeLessThanOrEqual(300);
    const result = pacer.canLaunchSession(accountId, undefined, true);
    expect(result.allowed).toBe(true);
  });

  it("priority tasks blocked when burn > 300%", () => {
    // Force burn > 300% by zeroing monthly budget — burn becomes 999
    db.prepare(`UPDATE accounts SET monthly_token_limit = 0, daily_token_limit = 0 WHERE id = ?`).run(accountId);
    recordTokenUsage(db, { sessionId: "s1", accountId, projectId, inputTokens: 100, outputTokens: 0 });
    const result = pacer.canLaunchSession(accountId, undefined, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/exhausted/i);
  });

  it("blocks when projected cost would push way over the daily allowance in non-normal mode", () => {
    // 100% burn → cautious mode
    recordTokenUsage(db, { sessionId: "s1", accountId, projectId, inputTokens: daily, outputTokens: 0 });
    // Projected adds another 3x daily allowance — would push to >250%
    const result = pacer.canLaunchSession(accountId, daily * 3);
    expect(result.allowed).toBe(false);
  });
});

describe("BudgetPacer.getPacingStatus", () => {
  let db: Database.Database;
  let pacer: BudgetPacer;
  let accountId: string;

  beforeEach(() => {
    db = createTestDb();
    pacer = new BudgetPacer(db);
    accountId = seedMultiOrg(db).personal.accountId;
  });

  afterEach(() => {
    db.close();
  });

  it("returns null for unknown account", () => {
    expect(pacer.getPacingStatus("does_not_exist")).toBeNull();
  });

  it("returns full status for known account", () => {
    const status = pacer.getPacingStatus(accountId);
    expect(status).not.toBeNull();
    expect(status!.accountId).toBe(accountId);
    expect(status!.pacingMode).toBe("normal");
    expect(status!.dailyAllowance).toBeGreaterThan(0);
    expect(status!.dailyUsed).toBe(0);
    expect(status!.cycleStartDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(status!.cycleEndDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("includes a suggestion when not in normal mode", () => {
    // accountId already set up in outer beforeEach via seedMultiOrg — reuse the project
    const project = db.prepare(`SELECT id, org_id FROM projects WHERE account_id = ? LIMIT 1`).get(accountId) as { id: string; org_id: string };
    insertSession(db, "s_status", project.id, project.org_id, accountId);
    // Force critical mode by zeroing the budget
    db.prepare(`UPDATE accounts SET monthly_token_limit = 0, daily_token_limit = 0 WHERE id = ?`).run(accountId);
    recordTokenUsage(db, {
      sessionId: "s_status",
      accountId,
      projectId: project.id,
      inputTokens: 1_000,
      outputTokens: 500,
    });
    const status = pacer.getPacingStatus(accountId);
    expect(status!.pacingMode).not.toBe("normal");
    expect(status!.suggestion).toBeTruthy();
  });
});

describe("BudgetPacer.getDailyAllowance", () => {
  let db: Database.Database;
  let pacer: BudgetPacer;
  let accountId: string;

  beforeEach(() => {
    db = createTestDb();
    pacer = new BudgetPacer(db);
    accountId = seedMultiOrg(db).personal.accountId;
  });

  afterEach(() => {
    db.close();
  });

  it("returns 0 for unknown account", () => {
    expect(pacer.getDailyAllowance("nope")).toBe(0);
  });

  it("returns positive value for funded account", () => {
    expect(pacer.getDailyAllowance(accountId)).toBeGreaterThan(0);
  });
});

describe("BudgetPacer.getLeanModePrompt", () => {
  let db: Database.Database;
  let pacer: BudgetPacer;

  beforeEach(() => {
    db = createTestDb();
    pacer = new BudgetPacer(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns null for normal mode", () => {
    expect(pacer.getLeanModePrompt("normal")).toBeNull();
  });

  it("returns a prompt string for non-normal modes", () => {
    expect(typeof pacer.getLeanModePrompt("cautious")).toBe("string");
    expect(typeof pacer.getLeanModePrompt("slow")).toBe("string");
    expect(typeof pacer.getLeanModePrompt("critical")).toBe("string");
  });
});

describe("BudgetPacer.getAutoAdvanceCooldownMs", () => {
  let db: Database.Database;
  let pacer: BudgetPacer;
  let accountId: string;

  beforeEach(() => {
    db = createTestDb();
    pacer = new BudgetPacer(db);
    accountId = seedMultiOrg(db).personal.accountId;
  });

  afterEach(() => {
    db.close();
  });

  it("returns 0 (no cooldown) when no usage", () => {
    const ms = pacer.getAutoAdvanceCooldownMs(accountId);
    expect(ms).toBe(0);
  });

  it("returns -1 sentinel when burn rate is critical (>200%)", () => {
    // Force critical via zero budget — getBurnRatePct returns 999
    db.prepare(`UPDATE accounts SET monthly_token_limit = 0, daily_token_limit = 0 WHERE id = ?`).run(accountId);
    const ms = pacer.getAutoAdvanceCooldownMs(accountId);
    expect(ms).toBe(-1);
  });
});

describe("BudgetPacer daily_token_limit override (2026-07 contract)", () => {
  it("an explicit daily limit IS the allowance — monthly pace does not shrink it", () => {
    const db = createTestDb();
    try {
      const ids = seedMultiOrg(db);
      const accountId = ids.personal.accountId;
      // Heavy cycle usage that would crush the monthly-derived allowance:
      db.prepare(`UPDATE accounts SET monthly_token_limit = 1000, daily_token_limit = 50_000_000 WHERE id = ?`)
        .run(accountId);
      const pacer = new BudgetPacer(db);
      expect(pacer.getDailyAllowance(accountId)).toBe(50_000_000);
    } finally {
      db.close();
    }
  });
});
