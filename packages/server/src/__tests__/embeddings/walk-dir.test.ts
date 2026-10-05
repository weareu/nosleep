import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkDir, MAX_FILES_PER_PROJECT } from "../../embeddings/vector-indexer.js";

/**
 * Behaviour tests for the async file walk. This replaced a synchronous,
 * unbounded recursive walk that froze the event loop for ~206s on a large
 * tree (the Linux-kernel checkout) and never completed under the watchdog.
 * The contract: bounded (caps at MAX_FILES_PER_PROJECT), selective (only
 * indexable extensions, skips vendored/hidden dirs), and tolerant of a
 * missing root.
 */
describe("walkDir", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "nosleep-walk-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("collects indexable files and skips non-indexable extensions", async () => {
    const dir = join(root, "exts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.ts"), "export const a = 1;");
    writeFileSync(join(dir, "b.py"), "x = 1");
    writeFileSync(join(dir, "c.md"), "# doc");
    writeFileSync(join(dir, "skip.png"), "binary");
    writeFileSync(join(dir, "skip.json"), "{}");

    const { files, capped } = await walkDir(dir);
    const names = files.map((f) => f.split("/").pop()).sort();

    expect(names).toEqual(["a.ts", "b.py", "c.md"]);
    expect(capped).toBe(false);
  });

  it("skips vendored dirs, hidden dirs/files, and skip-pattern files", async () => {
    const dir = join(root, "skips");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "dep.ts"), "x");
    writeFileSync(join(dir, ".git", "config.ts"), "x");
    writeFileSync(join(dir, ".hidden.ts"), "x");
    writeFileSync(join(dir, "bundle.min.js"), "x");
    writeFileSync(join(dir, "src", "real.ts"), "export const r = 1;");

    const { files } = await walkDir(dir);
    const names = files.map((f) => f.split("/").pop());

    expect(names).toEqual(["real.ts"]);
  });

  it("returns empty (not capped) for a non-existent root", async () => {
    const { files, capped } = await walkDir(join(root, "does-not-exist"));
    expect(files).toEqual([]);
    expect(capped).toBe(false);
  });

  it("caps at MAX_FILES_PER_PROJECT and reports capped=true", async () => {
    const dir = join(root, "huge");
    mkdirSync(dir, { recursive: true });
    // One more than the cap so the limit is genuinely exceeded.
    for (let i = 0; i < MAX_FILES_PER_PROJECT + 5; i++) {
      writeFileSync(join(dir, `f${i}.ts`), "x");
    }

    const { files, capped } = await walkDir(dir);
    expect(capped).toBe(true);
    expect(files.length).toBe(MAX_FILES_PER_PROJECT);
  });
});
