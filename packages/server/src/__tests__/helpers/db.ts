import { initializeDatabase } from "../../db/schema.js";
import type Database from "better-sqlite3";
import { createOrg } from "@nosleep/shared";

/** Generic user-defined test orgs, created through the real org path. */
export const TEST_ORGS = [
  { name: "Work", slug: "work", color: "#f59e0b" },
  { name: "Side", slug: "side", color: "#10b981" },
] as const;

/** Add the test orgs (org_work, org_side) beside the seeded org_personal. */
export function seedTestOrgs(db: Database.Database): void {
  for (const org of TEST_ORGS) createOrg(db, org);
}

/** Fresh in-memory DB (migrations applied) plus the generic test orgs. */
export function createTestDb(): Database.Database {
  const db = initializeDatabase(":memory:");
  seedTestOrgs(db);
  return db;
}

interface SeedIds {
  readonly orgId: string;
  readonly accountId: string;
  readonly projectId: string;
}

/**
 * Seeds a single org (org_personal) with one account and one project.
 * Returns the IDs for use in tests.
 */
export function seedTestData(db: Database.Database): SeedIds {
  const orgId = "org_personal";
  const accountId = "acc_personal_max";
  const projectId = "proj_test_001";

  db.prepare(`
    INSERT INTO accounts (id, org_id, name, type, daily_token_limit, monthly_token_limit)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(accountId, orgId, "Personal Max", "max", 10_000_000, 200_000_000);

  db.prepare(`
    INSERT INTO projects (id, org_id, name, path, account_id, token_budget, autonomy_level)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, orgId, "Test Project", "/tmp/test-project", accountId, 500_000, "supervised");

  return { orgId, accountId, projectId };
}

interface MultiOrgSeedIds {
  readonly personal: SeedIds;
  readonly work: SeedIds;
  readonly side: SeedIds;
}

/**
 * Seeds the 3 test orgs (personal, work, side) with accounts and projects.
 * Expects a DB from createTestDb() (which creates org_work/org_side).
 */
export function seedMultiOrg(db: Database.Database): MultiOrgSeedIds {
  // Personal
  db.prepare(`
    INSERT INTO accounts (id, org_id, name, type, daily_token_limit, monthly_token_limit)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("acc_personal_max", "org_personal", "Personal Max", "max", 10_000_000, 200_000_000);

  db.prepare(`
    INSERT INTO projects (id, org_id, name, path, account_id, token_budget)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("proj_personal_001", "org_personal", "Personal Project", "/tmp/personal", "acc_personal_max", 500_000);

  // Work
  db.prepare(`
    INSERT INTO accounts (id, org_id, name, type, daily_token_limit, monthly_token_limit)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("acc_work_team", "org_work", "Work Team", "team", 20_000_000, 400_000_000);

  db.prepare(`
    INSERT INTO projects (id, org_id, name, path, account_id, token_budget)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("proj_work_001", "org_work", "Work Project", "/tmp/work", "acc_work_team", 1_000_000);

  // Side
  db.prepare(`
    INSERT INTO accounts (id, org_id, name, type, daily_token_limit, monthly_token_limit)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("acc_side_pro", "org_side", "Side Pro", "pro", 5_000_000, 100_000_000);

  db.prepare(`
    INSERT INTO projects (id, org_id, name, path, account_id, token_budget)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("proj_side_001", "org_side", "Side Project", "/tmp/side", "acc_side_pro", 300_000);

  return {
    personal: { orgId: "org_personal", accountId: "acc_personal_max", projectId: "proj_personal_001" },
    work: { orgId: "org_work", accountId: "acc_work_team", projectId: "proj_work_001" },
    side: { orgId: "org_side", accountId: "acc_side_pro", projectId: "proj_side_001" },
  };
}
