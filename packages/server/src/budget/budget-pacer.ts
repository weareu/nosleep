import type Database from "better-sqlite3";
import type { PacingMode, BudgetPacingStatus } from "@nosleep/shared";
import {
  PACING_CAUTIOUS_PCT,
  PACING_SLOW_PCT,
  PACING_CRITICAL_PCT,
  DEFAULT_SESSION_COST_ESTIMATE,
} from "@nosleep/shared";
import { TokenTracker } from "./token-tracker.js";

interface AccountRow {
  readonly id: string;
  readonly daily_token_limit: number;
  readonly monthly_token_limit: number;
  readonly monthly_budget_usd: number;
  readonly billing_cycle_day: number;
}

interface LaunchCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly suggestion?: string;
  readonly pacingMode: PacingMode;
}

export class BudgetPacer {
  private readonly db: Database.Database;
  private readonly tracker: TokenTracker;

  constructor(db: Database.Database, tracker?: TokenTracker) {
    this.db = db;
    this.tracker = tracker ?? new TokenTracker(db);
  }

  /**
   * Calculate billing cycle date range for an account.
   * Handles edge cases: day 31 in Feb (clamps to last day of month), year boundaries.
   */
  getCycleRange(billingCycleDay: number, now?: Date): { start: Date; end: Date } {
    const today = now ?? new Date();
    const currentDay = today.getUTCDate();
    const currentMonth = today.getUTCMonth();
    const currentYear = today.getUTCFullYear();

    let startYear: number;
    let startMonth: number;
    let endYear: number;
    let endMonth: number;

    if (currentDay >= billingCycleDay) {
      // We're in the cycle that started this month
      startYear = currentYear;
      startMonth = currentMonth;
      endYear = currentMonth === 11 ? currentYear + 1 : currentYear;
      endMonth = (currentMonth + 1) % 12;
    } else {
      // We're in the cycle that started last month
      startMonth = currentMonth === 0 ? 11 : currentMonth - 1;
      startYear = currentMonth === 0 ? currentYear - 1 : currentYear;
      endYear = currentYear;
      endMonth = currentMonth;
    }

    const startDate = new Date(Date.UTC(
      startYear,
      startMonth,
      this.clampDay(billingCycleDay, startYear, startMonth),
    ));

    const endDate = new Date(Date.UTC(
      endYear,
      endMonth,
      this.clampDay(billingCycleDay, endYear, endMonth),
    ));

    return { start: startDate, end: endDate };
  }

  /**
   * How many days left in the current billing cycle (minimum 1).
   */
  getRemainingDays(billingCycleDay: number, now?: Date): number {
    const today = now ?? new Date();
    const { end } = this.getCycleRange(billingCycleDay, today);
    const msPerDay = 24 * 60 * 60 * 1000;
    const remaining = Math.ceil((end.getTime() - today.getTime()) / msPerDay);
    return Math.max(1, remaining);
  }

  /**
   * Total tokens used since cycle start for this account.
   */
  getCycleUsage(accountId: string, cycleStart: Date): number {
    const sinceDate = cycleStart.toISOString();
    const usage = this.tracker.getCycleUsage(accountId, sinceDate);
    return usage.totalTokens;
  }

  /**
   * Today's usage for this account.
   */
  getTodayUsage(accountId: string): number {
    const usage = this.tracker.getTodayUsage(accountId);
    return usage.totalTokens;
  }

  /**
   * Calculate daily allowance: remaining_monthly_budget / remaining_days.
   */
  getDailyAllowance(accountId: string): number {
    const account = this.getAccount(accountId);
    if (!account) return 0;

    // An explicit daily_token_limit is the HARD daily allowance (user-set
    // pacing knob). Before this, the column was dead: allowance was always
    // derived as remaining-monthly/remaining-days, which SHRINKS after heavy
    // days — a 10M "daily limit" account read >200% burn while its column
    // said 11.4M/10M = 114%. Monthly-derived pacing remains the fallback
    // when no daily limit is set.
    if (account.daily_token_limit > 0) return account.daily_token_limit;

    const { start } = this.getCycleRange(account.billing_cycle_day);
    const cycleUsage = this.getCycleUsage(accountId, start);
    const remainingBudget = Math.max(0, account.monthly_token_limit - cycleUsage);
    const remainingDays = this.getRemainingDays(account.billing_cycle_day);

    return Math.floor(remainingBudget / remainingDays);
  }

  /**
   * Burn rate: todayUsage / dailyAllowance * 100.
   */
  getBurnRatePct(accountId: string): number {
    const dailyAllowance = this.getDailyAllowance(accountId);
    if (dailyAllowance <= 0) return 999;

    const todayUsage = this.getTodayUsage(accountId);
    return Math.round((todayUsage / dailyAllowance) * 10000) / 100;
  }

  /**
   * Determine pacing mode from burn rate.
   */
  getPacingMode(accountId: string): PacingMode {
    const burnRate = this.getBurnRatePct(accountId);

    if (burnRate >= PACING_CRITICAL_PCT) return "critical";
    if (burnRate >= PACING_SLOW_PCT) return "slow";
    if (burnRate >= PACING_CAUTIOUS_PCT) return "cautious";
    return "normal";
  }

  /**
   * Full pacing status for API/dashboard consumption.
   */
  getPacingStatus(accountId: string): BudgetPacingStatus | null {
    const account = this.getAccount(accountId);
    if (!account) return null;

    const { start, end } = this.getCycleRange(account.billing_cycle_day);
    const cycleUsage = this.getCycleUsage(accountId, start);
    const todayUsage = this.getTodayUsage(accountId);
    const remainingBudget = Math.max(0, account.monthly_token_limit - cycleUsage);
    const remainingDays = this.getRemainingDays(account.billing_cycle_day);
    const dailyAllowance = remainingDays > 0 ? Math.floor(remainingBudget / remainingDays) : 0;
    const burnRatePct = dailyAllowance > 0
      ? Math.round((todayUsage / dailyAllowance) * 10000) / 100
      : 999;
    const pacingMode = this.getPacingMode(accountId);

    const suggestion = this.getSuggestion(pacingMode, burnRatePct);

    return {
      accountId,
      pacingMode,
      dailyAllowance,
      dailyUsed: todayUsage,
      burnRatePct,
      remainingMonthlyBudget: remainingBudget,
      remainingDaysInCycle: remainingDays,
      billingCycleDay: account.billing_cycle_day,
      cycleStartDate: start.toISOString().slice(0, 10),
      cycleEndDate: end.toISOString().slice(0, 10),
      suggestion: suggestion ?? undefined,
    };
  }

  /**
   * Can this session launch? Returns allowed, reason, suggestion, and pacing mode.
   * Only blocks when mode is critical AND burnRate > 200% (truly exhausted).
   * Priority nodes bypass some restrictions.
   */
  canLaunchSession(
    accountId: string,
    estimatedCost?: number,
    isPriority?: boolean,
  ): LaunchCheckResult {
    const pacingMode = this.getPacingMode(accountId);
    const burnRate = this.getBurnRatePct(accountId);

    // Priority tasks bypass everything except truly exhausted budgets
    if (isPriority) {
      if (burnRate > 300) {
        return {
          allowed: false,
          reason: "Monthly budget exhausted even for priority tasks",
          suggestion: "Wait for next billing cycle",
          pacingMode,
        };
      }
      return { allowed: true, pacingMode };
    }

    // Only block when critical AND burn rate > 200% (truly exhausted)
    if (pacingMode === "critical" && burnRate > 200) {
      return {
        allowed: false,
        reason: `Daily budget overdrawn (${burnRate}% of allowance used)`,
        suggestion: "Defer to tomorrow or reduce session scope",
        pacingMode,
      };
    }

    // Check if estimated cost would push us way over
    if (estimatedCost !== undefined) {
      const dailyAllowance = this.getDailyAllowance(accountId);
      const todayUsage = this.getTodayUsage(accountId);
      const projectedPct = dailyAllowance > 0
        ? ((todayUsage + estimatedCost) / dailyAllowance) * 100
        : 999;

      if (projectedPct > 250 && pacingMode !== "normal") {
        return {
          allowed: false,
          reason: `Estimated session cost would push usage to ${Math.round(projectedPct)}% of daily allowance`,
          suggestion: "Defer to tomorrow or use a smaller scope",
          pacingMode,
        };
      }
    }

    const suggestion = this.getSuggestion(pacingMode, burnRate);
    return {
      allowed: true,
      suggestion: suggestion ?? undefined,
      pacingMode,
    };
  }

  /**
   * Get lean mode system prompt injection (null if normal mode).
   */
  getLeanModePrompt(mode: PacingMode): string | null {
    switch (mode) {
      case "normal":
        return null;
      case "cautious":
        return "Budget note: Be concise. Prefer direct edits over exploration. Minimize unnecessary tool calls.";
      case "slow":
        return "BUDGET CONSTRAINED: Be extremely concise. Write code directly without exploring first. Minimize tool calls. Skip tests unless critical to acceptance criteria.";
      case "critical":
        return "BUDGET CRITICAL: Absolute minimum tool calls. Write code directly. No exploration. No tests. Complete the goal with minimal token usage.";
    }
  }

  /**
   * Calculate cooldown in milliseconds before auto-launching next task.
   * Higher burn rate = longer wait. Spreads work across the billing cycle.
   *
   * Returns 0 for normal pacing, up to hours for critical.
   */
  getAutoAdvanceCooldownMs(accountId: string): number {
    const burnRate = this.getBurnRatePct(accountId);

    // Under 50% of daily allowance: no cooldown, go fast
    if (burnRate < 50) return 0;
    // 50-80%: 5 minute cooldown between tasks
    if (burnRate < 80) return 5 * 60 * 1000;
    // 80-100%: 15 minute cooldown
    if (burnRate < 100) return 15 * 60 * 1000;
    // 100-150%: 1 hour cooldown (over daily budget but not critical)
    if (burnRate < 150) return 60 * 60 * 1000;
    // 150-200%: 2 hour cooldown
    if (burnRate < 200) return 2 * 60 * 60 * 1000;
    // >200%: stop auto-advancing entirely, wait for next day
    return -1; // sentinel: do not auto-advance
  }

  /**
   * Estimate session cost from historical average for this account.
   * Falls back to DEFAULT_SESSION_COST_ESTIMATE if no history.
   */
  estimateSessionCost(accountId: string): number {
    const row = this.db.prepare(`
      SELECT
        COALESCE(AVG(tokens_used), 0) AS avg_tokens
      FROM sessions
      WHERE account_id = ?
        AND status IN ('completed', 'failed')
        AND tokens_used > 0
    `).get(accountId) as { avg_tokens: number };

    return row.avg_tokens > 0
      ? Math.round(row.avg_tokens)
      : DEFAULT_SESSION_COST_ESTIMATE;
  }

  // ── USD Budget Methods ───────────────────────────────

  /**
   * Total USD spent in the current billing cycle for this account.
   * Uses the cost_usd field on sessions (reported by Claude CLI).
   */
  getCycleSpentUsd(accountId: string): number {
    const account = this.getAccount(accountId);
    if (!account) return 0;

    const { start } = this.getCycleRange(account.billing_cycle_day);
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS total_cost
      FROM sessions
      WHERE account_id = ?
        AND started_at >= ?
    `).get(accountId, start.toISOString()) as { total_cost: number };

    return row.total_cost;
  }

  /**
   * Today's USD spend for this account.
   */
  getTodaySpentUsd(accountId: string): number {
    const today = new Date().toISOString().slice(0, 10);
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS total_cost
      FROM sessions
      WHERE account_id = ?
        AND date(started_at) = ?
    `).get(accountId, today) as { total_cost: number };

    return row.total_cost;
  }

  /**
   * Daily USD allowance: remaining monthly budget / remaining days.
   */
  getDailyAllowanceUsd(accountId: string): number {
    const account = this.getAccount(accountId);
    if (!account) return 0;

    const cycleSpent = this.getCycleSpentUsd(accountId);
    const remainingBudget = Math.max(0, account.monthly_budget_usd - cycleSpent);
    const remainingDays = this.getRemainingDays(account.billing_cycle_day);

    return remainingBudget / remainingDays;
  }

  /**
   * Calculate a sensible per-session budget cap in USD.
   *
   * Formula:
   *   sessionBudget = dailyAllowanceUsd / expectedSessionsPerDay
   *
   * Constraints:
   *   - Floor: $3 (below this, sessions can't complete meaningful work)
   *   - Ceiling: 15% of monthly budget (prevents single-session blowout)
   *   - expectedSessionsPerDay: historical avg or default 5
   */
  getSessionBudgetUsd(accountId: string): number {
    const account = this.getAccount(accountId);
    if (!account) return 5.0; // Safe fallback

    const dailyAllowance = this.getDailyAllowanceUsd(accountId);
    const expectedSessions = this.getAvgSessionsPerDay(accountId);

    let sessionBudget = dailyAllowance / expectedSessions;

    // Floor: $3 minimum — anything less can't complete useful work with Opus
    const FLOOR = 3.0;
    // Ceiling: 15% of monthly — no single session should eat more than this
    const CEILING = account.monthly_budget_usd * 0.15;

    sessionBudget = Math.max(FLOOR, Math.min(sessionBudget, CEILING));

    return Math.round(sessionBudget * 100) / 100; // Round to cents
  }

  /**
   * Average sessions launched per day for this account over the last 14 days.
   * Falls back to 5 if no history.
   */
  private getAvgSessionsPerDay(accountId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total_sessions
      FROM sessions
      WHERE account_id = ?
        AND started_at >= datetime('now', '-14 days')
    `).get(accountId) as { total_sessions: number };

    if (row.total_sessions === 0) return 5; // Default assumption

    // Average over 14 days, minimum 2 sessions/day assumption
    return Math.max(2, row.total_sessions / 14);
  }

  // ── Internal ──────────────────────────────────────────

  private getAccount(accountId: string): AccountRow | null {
    return this.db.prepare(`
      SELECT id, daily_token_limit, monthly_token_limit, monthly_budget_usd, billing_cycle_day
      FROM accounts
      WHERE id = ?
    `).get(accountId) as AccountRow | null;
  }

  /**
   * Clamp a billing cycle day to the last valid day of the given month.
   */
  private clampDay(day: number, year: number, month: number): number {
    // Day 0 of next month = last day of this month
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Math.min(day, lastDay);
  }

  private getSuggestion(mode: PacingMode, burnRate: number): string | null {
    switch (mode) {
      case "normal":
        return null;
      case "cautious":
        return "Consider running in lean mode to preserve budget";
      case "slow":
        return "Run in lean mode. Defer non-essential tasks to tomorrow.";
      case "critical":
        return burnRate > 200
          ? "Defer to tomorrow. Budget is overdrawn."
          : "Only run priority tasks. Use minimal token mode.";
    }
  }
}
