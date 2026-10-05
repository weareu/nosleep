import type Database from "better-sqlite3";
import type { TokenBudgetStatus } from "@nosleep/shared";
import { TokenTracker } from "./token-tracker.js";

interface DailyBreakdownEntry {
  readonly date: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
}

interface AccountSummary {
  readonly accountId: string;
  readonly accountName: string;
  readonly orgId: string;
  readonly dailyUsed: number;
  readonly dailyLimit: number;
  readonly pctDailyUsed: number;
  readonly monthlyUsed: number;
  readonly monthlyLimit: number;
  readonly pctMonthlyUsed: number;
}

interface OrgSummary {
  readonly orgId: string;
  readonly orgName: string;
  readonly accounts: readonly AccountSummary[];
  readonly totalDailyUsed: number;
  readonly totalMonthlyUsed: number;
}

// Rough cost estimation: $3/M input, $15/M output (Sonnet-class pricing)
const INPUT_COST_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 15 / 1_000_000;

export class UsageAnalytics {
  private readonly db: Database.Database;
  private readonly tracker: TokenTracker;

  constructor(db: Database.Database, tracker: TokenTracker) {
    this.db = db;
    this.tracker = tracker;
  }

  /**
   * Get a full budget summary for a single account.
   */
  getAccountSummary(accountId: string): AccountSummary | null {
    const account = this.db.prepare(`
      SELECT id, name, org_id, daily_token_limit, monthly_token_limit
      FROM accounts
      WHERE id = ?
    `).get(accountId) as {
      id: string;
      name: string;
      org_id: string;
      daily_token_limit: number;
      monthly_token_limit: number;
    } | null;

    if (!account) return null;

    const daily = this.tracker.getDailyUsage(accountId);
    const monthly = this.tracker.getMonthlyUsage(accountId);

    return {
      accountId: account.id,
      accountName: account.name,
      orgId: account.org_id,
      dailyUsed: daily.totalTokens,
      dailyLimit: account.daily_token_limit,
      pctDailyUsed: account.daily_token_limit > 0
        ? Math.round((daily.totalTokens / account.daily_token_limit) * 10000) / 100
        : 0,
      monthlyUsed: monthly.totalTokens,
      monthlyLimit: account.monthly_token_limit,
      pctMonthlyUsed: account.monthly_token_limit > 0
        ? Math.round((monthly.totalTokens / account.monthly_token_limit) * 10000) / 100
        : 0,
    };
  }

  /**
   * Aggregate usage across all accounts in an organization.
   */
  getOrgSummary(orgId: string): OrgSummary | null {
    const org = this.db.prepare(`
      SELECT id, name FROM organizations WHERE id = ?
    `).get(orgId) as { id: string; name: string } | null;

    if (!org) return null;

    const accountRows = this.db.prepare(`
      SELECT id FROM accounts WHERE org_id = ?
    `).all(orgId) as readonly { id: string }[];

    const accounts = accountRows
      .map((row) => this.getAccountSummary(row.id))
      .filter((a): a is AccountSummary => a !== null);

    return {
      orgId: org.id,
      orgName: org.name,
      accounts,
      totalDailyUsed: accounts.reduce((sum, a) => sum + a.dailyUsed, 0),
      totalMonthlyUsed: accounts.reduce((sum, a) => sum + a.monthlyUsed, 0),
    };
  }

  /**
   * Get daily token breakdown with estimated cost for the last N days.
   */
  getDailyBreakdown(accountId: string, days: number): readonly DailyBreakdownEntry[] {
    const breakdown = this.tracker.getDailyBreakdown(accountId, days);

    return breakdown.map((entry) => ({
      date: entry.date,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cost: Math.round(
        (entry.inputTokens * INPUT_COST_PER_TOKEN +
          entry.outputTokens * OUTPUT_COST_PER_TOKEN) * 10000,
      ) / 10000,
    }));
  }

  /**
   * Get budget status for all accounts (used by dashboard).
   */
  getAllAccountsBudgetStatus(): readonly TokenBudgetStatus[] {
    const accounts = this.db.prepare(`
      SELECT id, org_id, daily_token_limit, monthly_token_limit
      FROM accounts
    `).all() as readonly {
      id: string;
      org_id: string;
      daily_token_limit: number;
      monthly_token_limit: number;
    }[];

    return accounts.map((account) => {
      const daily = this.tracker.getDailyUsage(account.id);
      const monthly = this.tracker.getMonthlyUsage(account.id);

      return {
        orgId: account.org_id,
        accountId: account.id,
        dailyUsed: daily.totalTokens,
        dailyLimit: account.daily_token_limit,
        monthlyUsed: monthly.totalTokens,
        monthlyLimit: account.monthly_token_limit,
        pctDailyUsed: account.daily_token_limit > 0
          ? Math.round((daily.totalTokens / account.daily_token_limit) * 10000) / 100
          : 0,
        pctMonthlyUsed: account.monthly_token_limit > 0
          ? Math.round((monthly.totalTokens / account.monthly_token_limit) * 10000) / 100
          : 0,
      };
    });
  }
}
