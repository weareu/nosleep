import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, seedMemoryData } from "../helpers/db.js";
import {
  storeMemory,
  retrieveMemory,
  listMemory,
  deleteMemory,
} from "../../memory-ops.js";

const ORG_PERSONAL = "org_personal";
const ORG_WORK = "org_work";

describe("org isolation", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();

    // Store memory in org_personal
    storeMemory(db, ORG_PERSONAL, {
      category: "fact",
      key: "secret-personal",
      value: "Personal org secret data",
    });

    // Store memory in org_work
    storeMemory(db, ORG_WORK, {
      category: "fact",
      key: "secret-work",
      value: "Work org secret data",
    });
  });

  it("memory in org_personal is NOT visible from org_work", () => {
    const result = retrieveMemory(db, ORG_WORK, {
      query: "secret-personal",
      limit: 10,
    });

    expect(result.content[0].text).toContain("No memories found");
  });

  it("memory in org_work is NOT visible from org_personal", () => {
    const result = retrieveMemory(db, ORG_PERSONAL, {
      query: "secret-work",
      limit: 10,
    });

    expect(result.content[0].text).toContain("No memories found");
  });

  it("each org only sees its own memories in list", () => {
    const personalList = listMemory(db, ORG_PERSONAL, {});
    const workList = listMemory(db, ORG_WORK, {});

    expect(personalList.content[0].text).toContain("secret-personal");
    expect(personalList.content[0].text).not.toContain("secret-work");

    expect(workList.content[0].text).toContain("secret-work");
    expect(workList.content[0].text).not.toContain("secret-personal");
  });

  it("search returns only same-org results", () => {
    // Both orgs have "secret" in the key
    const personalResults = retrieveMemory(db, ORG_PERSONAL, {
      query: "secret",
      limit: 10,
    });
    const workResults = retrieveMemory(db, ORG_WORK, {
      query: "secret",
      limit: 10,
    });

    expect(personalResults.content[0].text).toContain("secret-personal");
    expect(personalResults.content[0].text).not.toContain("secret-work");

    expect(workResults.content[0].text).toContain("secret-work");
    expect(workResults.content[0].text).not.toContain("secret-personal");
  });

  it("delete in org_personal does NOT affect org_work", () => {
    // Get the personal memory ID
    const personalRow = db
      .prepare("SELECT id FROM memory WHERE org_id = ? AND key = ?")
      .get(ORG_PERSONAL, "secret-personal") as { id: string };

    // Try to delete it from org_work (should fail silently)
    const crossOrgResult = deleteMemory(db, ORG_WORK, { id: personalRow.id });
    expect(crossOrgResult.content[0].text).toContain("not found");

    // Verify it still exists in org_personal
    const stillExists = retrieveMemory(db, ORG_PERSONAL, {
      query: "secret-personal",
      limit: 10,
    });
    expect(stillExists.content[0].text).toContain("secret-personal");
  });

  it("delete in org_personal works correctly for own data", () => {
    const personalRow = db
      .prepare("SELECT id FROM memory WHERE org_id = ? AND key = ?")
      .get(ORG_PERSONAL, "secret-personal") as { id: string };

    const result = deleteMemory(db, ORG_PERSONAL, { id: personalRow.id });
    expect(result.content[0].text).toContain("Deleted memory");

    // Verify it is gone
    const gone = retrieveMemory(db, ORG_PERSONAL, {
      query: "secret-personal",
      limit: 10,
    });
    expect(gone.content[0].text).toContain("No memories found");

    // Verify org_work data is untouched
    const workStillThere = retrieveMemory(db, ORG_WORK, {
      query: "secret-work",
      limit: 10,
    });
    expect(workStillThere.content[0].text).toContain("secret-work");
  });
});
