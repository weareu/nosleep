import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations, safeAlter, getCurrentSchemaVersion, type Migration } from "../../db/migrations.js";
import { MIGRATIONS } from "../../db/migrations-list.js";
import { initializeDatabase } from "../../db/schema.js";

describe("safeAlter", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.prepare(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`).run();
  });

  afterEach(() => db.close());

  it("applies a fresh ALTER", () => {
    safeAlter(db, `ALTER TABLE t ADD COLUMN extra TEXT`);
    const cols = db.prepare(`PRAGMA table_info(t)`).all() as Array<{ name: string }>;
    expect(cols.find((c) => c.name === "extra")).toBeDefined();
  });

  it("swallows duplicate-column errors silently", () => {
    safeAlter(db, `ALTER TABLE t ADD COLUMN extra TEXT`);
    expect(() => safeAlter(db, `ALTER TABLE t ADD COLUMN extra TEXT`)).not.toThrow();
  });

  it("re-throws other SQL errors", () => {
    expect(() => safeAlter(db, `ALTER TABLE doesnotexist ADD COLUMN x TEXT`)).toThrow(/no such table/);
  });
});

describe("runMigrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => db.close());

  it("creates schema_migrations table on first run", () => {
    runMigrations(db, []);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it("applies migrations in order", () => {
    const order: number[] = [];
    const migrations: Migration[] = [
      { version: 1, name: "first", up: () => order.push(1) },
      { version: 2, name: "second", up: () => order.push(2) },
      { version: 3, name: "third", up: () => order.push(3) },
    ];
    runMigrations(db, migrations);
    expect(order).toEqual([1, 2, 3]);
  });

  it("records applied versions in schema_migrations", () => {
    runMigrations(db, [
      { version: 1, name: "alpha", up: () => {} },
      { version: 2, name: "beta", up: () => {} },
    ]);
    const rows = db
      .prepare(`SELECT version, name FROM schema_migrations ORDER BY version`)
      .all() as Array<{ version: number; name: string }>;
    expect(rows).toEqual([
      { version: 1, name: "alpha" },
      { version: 2, name: "beta" },
    ]);
  });

  it("skips already-applied migrations on subsequent runs", () => {
    const upFn = vi.fn();
    const migrations: Migration[] = [{ version: 1, name: "once", up: upFn }];

    runMigrations(db, migrations);
    runMigrations(db, migrations);
    runMigrations(db, migrations);

    expect(upFn).toHaveBeenCalledTimes(1);
  });

  it("applies new migrations when versions are added later", () => {
    const ups: number[] = [];
    runMigrations(db, [{ version: 1, name: "one", up: () => ups.push(1) }]);
    expect(ups).toEqual([1]);

    runMigrations(db, [
      { version: 1, name: "one", up: () => ups.push(1) },
      { version: 2, name: "two", up: () => ups.push(2) },
    ]);
    expect(ups).toEqual([1, 2]);
  });

  it("rolls back on failure within an up()", () => {
    expect(() =>
      runMigrations(db, [
        {
          version: 1,
          name: "boom",
          up: (db) => {
            db.prepare(`CREATE TABLE created (id INTEGER)`).run();
            throw new Error("kaboom");
          },
        },
      ]),
    ).toThrow(/kaboom/);

    // Both the table create AND the schema_migrations insert should be rolled back
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='created'`)
      .all();
    expect(tables).toEqual([]);
    const applied = db.prepare(`SELECT * FROM schema_migrations`).all();
    expect(applied).toEqual([]);
  });

  it("rejects non-ascending version ordering", () => {
    const migrations: Migration[] = [
      { version: 2, name: "later", up: () => {} },
      { version: 1, name: "earlier", up: () => {} },
    ];
    expect(() => runMigrations(db, migrations)).toThrow(/strictly ascending/);
  });

  it("rejects duplicate version numbers", () => {
    const migrations: Migration[] = [
      { version: 1, name: "a", up: () => {} },
      { version: 1, name: "b", up: () => {} },
    ];
    expect(() => runMigrations(db, migrations)).toThrow(/strictly ascending/);
  });
});

describe("getCurrentSchemaVersion", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => db.close());

  it("returns 0 when no migrations applied", () => {
    runMigrations(db, []);
    expect(getCurrentSchemaVersion(db)).toBe(0);
  });

  it("returns the highest applied version", () => {
    runMigrations(db, [
      { version: 5, name: "five", up: () => {} },
      { version: 7, name: "seven", up: () => {} },
    ]);
    expect(getCurrentSchemaVersion(db)).toBe(7);
  });
});

describe("Production migration list", () => {
  it("has strictly ascending version numbers with no gaps", () => {
    let lastSeen = 0;
    for (const m of MIGRATIONS) {
      expect(m.version).toBe(lastSeen + 1); // strictly +1 each
      lastSeen = m.version;
    }
  });

  it("every migration has a non-empty name", () => {
    for (const m of MIGRATIONS) {
      expect(m.name).toBeTruthy();
      expect(m.name.length).toBeGreaterThan(0);
    }
  });

  it("initializeDatabase applies all migrations on a fresh DB", () => {
    const db = initializeDatabase(":memory:");
    const expectedVersion = MIGRATIONS[MIGRATIONS.length - 1].version;
    expect(getCurrentSchemaVersion(db)).toBe(expectedVersion);
    db.close();
  });

  it("re-running initializeDatabase does not error and preserves state", () => {
    const db1 = initializeDatabase(":memory:");
    const v1 = getCurrentSchemaVersion(db1);
    db1.close();

    // Fresh in-memory DB — same migrations should apply identically
    const db2 = initializeDatabase(":memory:");
    expect(getCurrentSchemaVersion(db2)).toBe(v1);
    db2.close();
  });

  it("creates expected tables (organizations, sessions, projects, etc.)", () => {
    const db = initializeDatabase(":memory:");
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("organizations");
    expect(names).toContain("accounts");
    expect(names).toContain("projects");
    expect(names).toContain("sessions");
    expect(names).toContain("strategy_nodes");
    expect(names).toContain("alerts");
    expect(names).toContain("scheduled_tasks");
    expect(names).toContain("schema_migrations");
    db.close();
  });

  it("seeds only the default Personal org on a fresh install", () => {
    const db = initializeDatabase(":memory:");
    const orgs = db.prepare(`SELECT id, name, slug, color FROM organizations`).all();
    expect(orgs).toEqual([{ id: "org_personal", name: "Personal", slug: "personal", color: "#6366f1" }]);
    const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'organizations'`).get() as { sql: string }).sql;
    expect(sql).not.toMatch(/CHECK/i);
    db.close();
  });

  it("creates sessions.org_id with backfill capability", () => {
    const db = initializeDatabase(":memory:");
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    expect(cols.find((c) => c.name === "org_id")).toBeDefined();
    expect(cols.find((c) => c.name === "parent_session_id")).toBeDefined();
    expect(cols.find((c) => c.name === "failure_mode")).toBeDefined();
    db.close();
  });
});

// ── v25: organizations rebuilt without the fixed-slug CHECK ───────────

/**
 * Build a DB the way an older install has it: `organizations` created with a
 * CHECK pinning slug to a fixed list, three orgs, migrations 1-24 applied, and
 * child rows in every org-referencing table.
 */
function buildLegacyDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.prepare(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE CHECK(slug IN ('personal', 'work', 'side')),
      color TEXT NOT NULL DEFAULT '#6366f1',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  const ins = db.prepare(`INSERT INTO organizations (id, name, slug, color, created_at) VALUES (?, ?, ?, ?, ?)`);
  ins.run("org_personal", "Personal", "personal", "#6366f1", "2025-01-01 00:00:00");
  ins.run("org_work", "Work", "work", "#f59e0b", "2025-01-02 00:00:00");
  ins.run("org_side", "Side", "side", "#10b981", "2025-01-03 00:00:00");
  runMigrations(db, MIGRATIONS.filter((m) => m.version < 25));

  for (const org of ["personal", "work", "side"]) {
    const orgId = `org_${org}`;
    db.prepare(`INSERT INTO accounts (id, org_id, name, type) VALUES (?, ?, ?, 'max')`).run(`acc_${org}`, orgId, `${org} acc`);
    db.prepare(`INSERT INTO projects (id, org_id, name, path, account_id) VALUES (?, ?, ?, ?, ?)`)
      .run(`proj_${org}`, orgId, `${org} proj`, `/tmp/${org}`, `acc_${org}`);
    db.prepare(`INSERT INTO sessions (id, project_id, account_id, goal_text, goal_hash, org_id) VALUES (?, ?, ?, 'g', 'h', ?)`)
      .run(`sess_${org}`, `proj_${org}`, `acc_${org}`, orgId);
    db.prepare(`INSERT INTO strategy_nodes (id, project_id, org_id, type, title) VALUES (?, ?, ?, 'goal', 't')`)
      .run(`node_${org}`, `proj_${org}`, orgId);
    db.prepare(`INSERT INTO alerts (org_id, type, message) VALUES (?, 'info', 'm')`).run(orgId);
    db.prepare(`INSERT INTO memory (id, org_id, category, key, value) VALUES (?, ?, 'fact', 'k', 'v')`).run(`mem_${org}`, orgId);
    db.prepare(`INSERT INTO session_messages (id, from_session_id, org_id, type, payload) VALUES (?, ?, ?, 'info', 'p')`).run(`msg_${org}`, `sess_${org}`, orgId);
  }
  return db;
}

/** Every row of every user table, keyed by table — for before/after equality. */
function snapshot(db: Database.Database): Record<string, unknown[]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         AND name != 'schema_migrations' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    out[name] = db.prepare(`SELECT * FROM "${name}"`).all().map((r) => JSON.stringify(r)).sort();
  }
  return out;
}

describe("migration 25 organizations_user_defined", () => {
  it("removes the slug CHECK while preserving every row, id and FK", () => {
    const db = buildLegacyDb();
    expect(() => db.prepare(`INSERT INTO organizations (id, name, slug) VALUES ('org_x', 'X', 'x')`).run()).toThrow(/CHECK/);
    const before = snapshot(db);

    runMigrations(db, MIGRATIONS);

    expect(snapshot(db)).toEqual(before);
    const orgSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'organizations'`).get() as { sql: string }).sql;
    expect(orgSql).not.toMatch(/CHECK/i);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(getCurrentSchemaVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'organizations_rebuild'`).get()).toBeUndefined();

    // Child tables still reference organizations(id) and FKs are enforced.
    const accFks = db.pragma("foreign_key_list(accounts)") as Array<{ table: string; from: string }>;
    expect(accFks.find((f) => f.from === "org_id")?.table).toBe("organizations");
    expect(() =>
      db.prepare(`INSERT INTO accounts (id, org_id, name, type) VALUES ('acc_bad', 'org_missing', 'b', 'max')`).run(),
    ).toThrow(/FOREIGN KEY/);
    // Arbitrary slugs are now accepted.
    db.prepare(`INSERT INTO organizations (id, name, slug) VALUES ('org_client-x', 'Client X', 'client-x')`).run();
    db.close();
  });

  it("is idempotent — re-running on a rebuilt table changes nothing", () => {
    const db = buildLegacyDb();
    runMigrations(db, MIGRATIONS);
    const after = snapshot(db);
    const v25 = MIGRATIONS.find((m) => m.version === 25)!;
    db.transaction(() => v25.up(db))();
    runMigrations(db, MIGRATIONS);
    expect(snapshot(db)).toEqual(after);
    db.close();
  });

  it("does not brick boot on orphan rows that predate the migration", () => {
    const db = buildLegacyDb();
    db.pragma("foreign_keys = OFF");
    db.prepare(`INSERT INTO alerts (org_id, type, message) VALUES ('org_gone', 'info', 'orphan')`).run();
    db.pragma("foreign_keys = ON");
    expect(() => runMigrations(db, MIGRATIONS)).not.toThrow();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE org_id = 'org_gone'`).get() as { n: number }).n).toBe(1);
    db.close();
  });
});

describe("runMigrations foreignKeysOff", () => {
  it("rolls back a migration that introduces FK violations and restores foreign_keys", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.prepare(`CREATE TABLE p (id TEXT PRIMARY KEY)`).run();
    db.prepare(`CREATE TABLE c (id TEXT PRIMARY KEY, p_id TEXT REFERENCES p(id))`).run();
    const bad: Migration = {
      version: 1,
      name: "orphaning",
      foreignKeysOff: true,
      up: (d) => d.prepare(`INSERT INTO c (id, p_id) VALUES ('c1', 'nope')`).run(),
    };
    expect(() => runMigrations(db, [bad])).toThrow(/foreign key violations/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM c`).get()).toEqual({ n: 0 });
    expect(getCurrentSchemaVersion(db)).toBe(0);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });
});
