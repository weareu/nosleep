import type Database from "better-sqlite3";
import type { PacingMode } from "@nosleep/shared";
import { TokenTracker } from "./token-tracker.js";
import { BudgetPacer } from "./budget-pacer.js";

interface BudgetCheckResult {
  readonly allowed: boolean;
  readonly pctUsed: number;
  readonly warning?: string;
  readonly pacingMode: PacingMode;
}

export class BudgetEnforcer {
  private readonly pacer: BudgetPacer;

  constructor(db: Database.Database, tracker: TokenTracker) {
    this.pacer = new BudgetPacer(db, tracker);
  }

  /**
   * Full budget check for an account using the pacing system.
   * Returns allowed: false only when mode is critical AND burnRate > 200%.
   */
  checkBudget(accountId: string): BudgetCheckResult {
    const pacingMode = this.pacer.getPacingMode(accountId);
    const burnRate = this.pacer.getBurnRatePct(accountId);
    const status = this.pacer.getPacingStatus(accountId);

    const pctUsed = burnRate;
    const allowed = !(pacingMode === "critical" && burnRate > 200);

    let warning: string | undefined;

    switch (pacingMode) {
      case "critical":
        warning = allowed
          ? `CRITICAL: Daily budget at ${pctUsed}% of allowance. Only priority tasks should run.`
          : `Daily budget exhausted (${pctUsed}% of allowance). Sessions blocked.`;
        break;
      case "slow":
        warning = `Budget constrained: ${pctUsed}% of daily allowance used. Running in lean mode.`;
        break;
      case "cautious":
        warning = `Budget note: ${pctUsed}% of daily allowance used.`;
        break;
      case "normal":
        warning = undefined;
        break;
    }

    return { allowed, pctUsed, warning, pacingMode };
  }
}
