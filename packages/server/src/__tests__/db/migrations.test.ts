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

  it("seeds the three orgs", () => {
    const db = initializeDatabase(":memory:");
    const orgs = db.prepare(`SELECT slug FROM organizations ORDER BY slug`).all() as Array<{ slug: string }>;
    expect(orgs.map((o) => o.slug)).toEqual(["apply", "personal", "wyobi"]);
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
