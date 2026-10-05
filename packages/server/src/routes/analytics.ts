import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { TokenTracker } from "../budget/token-tracker.js";
import { UsageAnalytics } from "../budget/usage-analytics.js";
import { BudgetEnforcer } from "../budget/budget-enforcer.js";
import { BudgetPacer } from "../budget/budget-pacer.js";

export function registerAnalyticsRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
  pacer?: BudgetPacer,
): void {
  const tracker = new TokenTracker(db);
  const analytics = new UsageAnalytics(db, tracker);
  const enforcer = new BudgetEnforcer(db, tracker);
  const budgetPacer = pacer ?? new BudgetPacer(db, tracker);

  // GET /api/analytics/tokens?accountId=&days=
  // Daily token breakdown for an account
  fastify.get("/api/analytics/tokens", async (request, reply) => {
    const { accountId, days } = request.query as {
      accountId?: string;
      days?: string;
    };

    if (!accountId) {
      return reply.status(400).send({
        success: false,
        error: "accountId query parameter is required",
      });
    }

    const numDays = parseInt(days ?? "30", 10);
    if (isNaN(numDays) || numDays < 1 || numDays > 365) {
      return reply.status(400).send({
        success: false,
        error: "days must be between 1 and 365",
      });
    }

    const breakdown = analytics.getDailyBreakdown(accountId, numDays);
    const summary = analytics.getAccountSummary(accountId);

    return {
      success: true,
      data: {
        summary,
        breakdown,
      },
    };
  });

  // GET /api/analytics/tokens/org?orgId=
  // Org-level usage summary
  fastify.get("/api/analytics/tokens/org", async (request, reply) => {
    const { orgId } = request.query as { orgId?: string };

    if (!orgId) {
      return reply.status(400).send({
        success: false,
        error: "orgId query parameter is required",
      });
    }

    const summary = analytics.getOrgSummary(orgId);

    if (!summary) {
      return reply.status(404).send({
        success: false,
        error: "Organization not found",
      });
    }

    return {
      success: true,
      data: summary,
    };
  });

  // GET /api/analytics/budget
  // All accounts budget status with pacing data
  fastify.get("/api/analytics/budget", async () => {
    const statuses = analytics.getAllAccountsBudgetStatus();

    const enriched = statuses.map((status) => {
      const budgetCheck = enforcer.checkBudget(status.accountId);
      const pacingStatus = budgetPacer.getPacingStatus(status.accountId);
      return {
        ...status,
        allowed: budgetCheck.allowed,
        warning: budgetCheck.warning ?? null,
        pacingMode: budgetCheck.pacingMode,
        pacing: pacingStatus,
      };
    });

    return {
      success: true,
      data: enriched,
    };
  });

  // GET /api/analytics/pacing?accountId=
  // Budget pacing status for a specific account
  fastify.get("/api/analytics/pacing", async (request, reply) => {
    const { accountId } = request.query as { accountId?: string };

    if (!accountId) {
      return reply.status(400).send({
        success: false,
        error: "accountId query parameter is required",
      });
    }

    const pacingStatus = budgetPacer.getPacingStatus(accountId);

    if (!pacingStatus) {
      return reply.status(404).send({
        success: false,
        error: "Account not found",
      });
    }

    return {
      success: true,
      data: pacingStatus,
    };
  });
}
