import { initializeDatabase } from "../../db/schema.js";
import type Database from "better-sqlite3";

export function createTestDb(): Database.Database {
  return initializeDatabase(":memory:");
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
  readonly wyobi: SeedIds;
  readonly apply: SeedIds;
}

/**
 * Seeds all 3 orgs with accounts and projects.
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

  // Wyobi
  db.prepare(`
    INSERT INTO accounts (id, org_id, name, type, daily_token_limit, monthly_token_limit)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("acc_wyobi_team", "org_wyobi", "Wyobi Team", "team", 20_000_000, 400_000_000);

  db.prepare(`
    INSERT INTO projects (id, org_id, name, path, account_id, token_budget)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("proj_wyobi_001", "org_wyobi", "Wyobi Project", "/tmp/wyobi", "acc_wyobi_team", 1_000_000);

  // Apply
  db.prepare(`
    INSERT INTO accounts (id, org_id, name, type, daily_token_limit, monthly_token_limit)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("acc_apply_pro", "org_apply", "Apply Pro", "pro", 5_000_000, 100_000_000);

  db.prepare(`
    INSERT INTO projects (id, org_id, name, path, account_id, token_budget)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("proj_apply_001", "org_apply", "Apply Project", "/tmp/apply", "acc_apply_pro", 300_000);

  return {
    personal: { orgId: "org_personal", accountId: "acc_personal_max", projectId: "proj_personal_001" },
    wyobi: { orgId: "org_wyobi", accountId: "acc_wyobi_team", projectId: "proj_wyobi_001" },
    apply: { orgId: "org_apply", accountId: "acc_apply_pro", projectId: "proj_apply_001" },
  };
}
