/**
 * Phase 5-cont2 tests — FS attrs, numeric meta, git-blame authorship,
 * exifr + pdf-parse fallback paths, Claude-vision provider shape.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-p5c2-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

import { ingest } from "../ingest/pipeline.js";
import {
  statToAttrs,
  runFsAttrExtraction,
} from "../extractors/fs-attributes.js";
import { runNumericMetaExtraction } from "../extractors/numeric-meta.js";
import {
  fetchGitAuthorship,
  runGitAuthorshipExtraction,
} from "../extractors/git-authorship.js";
import {
  createExifrProvider,
  isExifrAvailable,
} from "../extractors/exif-provider-exifr.js";
import {
  extractPdf,
  isPdfParseAvailable,
} from "../extractors/pdf-handler.js";
import {
  createClaudeVisionProviders,
  isClaudeCliAvailable,
} from "../extractors/claude-vision-provider.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";

const ORG = "org_p5c2_test";
const PROJ = "proj_p5c2";

beforeAll(() => {
  activeDbFor(ORG);
});

afterAll(() => {
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("phase 5-cont2 — FS attributes", () => {
  test("statToAttrs reads real file stats", () => {
    const f = path.join(tmpDataDir, "stat-test.txt");
    fs.writeFileSync(f, "hello world");
    const attrs = statToAttrs(f);
    expect(attrs).not.toBeNull();
    expect(attrs!.size).toBe(11);
    expect(attrs!.mtime).toBeGreaterThan(0);
    expect(attrs!.extension).toBe(".txt");
    expect(attrs!.is_dir).toBe(false);
  });

  test("statToAttrs returns null for missing file", () => {
    const attrs = statToAttrs("/this/definitely/does/not/exist/anywhere");
    expect(attrs).toBeNull();
  });

  test("runFsAttrExtraction writes fs.* rows to artifact_num_meta", () => {
    const f = path.join(tmpDataDir, "attr-target.txt");
    fs.writeFileSync(f, "xyzzy");
    const r = ingest({
      kind: "code/file_snapshot",
      content: "placeholder",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      kind_specific_meta: { file_path: f },
      schema_version: 1,
    });
    runFsAttrExtraction({
      hash: r.hash,
      file_path: f,
      project_id: PROJ,
      org_id: ORG,
    });

    const db = activeDbFor(ORG);
    const rows = db
      .prepare(
        "SELECT key, value FROM artifact_num_meta WHERE hash = ? AND key LIKE 'fs.%'",
      )
      .all(r.hash) as Array<{ key: string; value: number }>;
    const keys = new Set(rows.map((x) => x.key));
    expect(keys.has("fs.size")).toBe(true);
    expect(keys.has("fs.mtime")).toBe(true);
    expect(keys.has("fs.ctime")).toBe(true);
  });
});

describe("phase 5-cont2 — numeric metadata", () => {
  test("parses known numeric keys into artifact_num_meta", () => {
    const r = ingest({
      kind: "process/command_output",
      content: "sample output",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      kind_specific_meta: {
        exit_code: 1,
        duration_ms: 1234,
        output_length: 99,
      },
      schema_version: 1,
    });
    const db = activeDbFor(ORG);
    const rows = db
      .prepare("SELECT key, value FROM artifact_num_meta WHERE hash = ?")
      .all(r.hash) as Array<{ key: string; value: number }>;
    const byKey = new Map(rows.map((x) => [x.key, x.value]));
    expect(byKey.get("exit_code")).toBe(1);
    expect(byKey.get("duration_ms")).toBe(1234);
    expect(byKey.get("output_length")).toBe(99);
  });

  test("runNumericMetaExtraction coerces strings and booleans", () => {
    const r = ingest({
      kind: "code/diff",
      content: "diff --git a/x b/x",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });
    const written = runNumericMetaExtraction({
      hash: r.hash,
      kind: "code/diff",
      kind_specific_meta: {
        lines_added: "42",
        lines_removed: 3,
        files_changed: true,
      },
      org_id: ORG,
      project_id: PROJ,
    });
    expect(written).toBe(3);
    const db = activeDbFor(ORG);
    const rows = db
      .prepare("SELECT key, value FROM artifact_num_meta WHERE hash = ?")
      .all(r.hash) as Array<{ key: string; value: number }>;
    const byKey = new Map(rows.map((x) => [x.key, x.value]));
    expect(byKey.get("lines_added")).toBe(42);
    expect(byKey.get("lines_removed")).toBe(3);
    expect(byKey.get("files_changed")).toBe(1);
  });

  test("ignores numeric keys not in the taxonomy allowlist", () => {
    const r = ingest({
      kind: "knowledge/note",
      content: "nn",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      kind_specific_meta: { random_key: 999 },
      schema_version: 1,
    });
    const db = activeDbFor(ORG);
    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM artifact_num_meta WHERE hash = ?")
      .get(r.hash) as { c: number };
    expect(rows.c).toBe(0);
  });
});

describe("phase 5-cont2 — git authorship", () => {
  test("fetchGitAuthorship returns null for non-git file", async () => {
    const f = path.join(tmpDataDir, "not-in-git.txt");
    fs.writeFileSync(f, "hello");
    const r = await fetchGitAuthorship(f);
    expect(r).toBeNull();
  });

  test("fetchGitAuthorship returns author for file in a git repo", async () => {
    const repo = path.join(tmpDataDir, "gitrepo");
    fs.mkdirSync(repo);
    execSync("git init -q", { cwd: repo });
    execSync('git config user.email "t@t.com"', { cwd: repo });
    execSync('git config user.name "TestUser"', { cwd: repo });
    const f = path.join(repo, "f.txt");
    fs.writeFileSync(f, "hi");
    execSync("git add -A && git commit -q -m 'initial'", { cwd: repo });

    const r = await fetchGitAuthorship(f);
    expect(r).not.toBeNull();
    expect(r!.last_author_name).toBe("TestUser");
    expect(r!.last_commit_sha.length).toBeGreaterThan(6);
    expect(r!.last_commit_ts).toBeGreaterThan(0);
  });

  test("runGitAuthorshipExtraction writes kind_specific_meta.git", async () => {
    const repo = path.join(tmpDataDir, "gitrepo2");
    fs.mkdirSync(repo);
    execSync("git init -q", { cwd: repo });
    execSync('git config user.email "a@a.com"', { cwd: repo });
    execSync('git config user.name "Aliceson"', { cwd: repo });
    const f = path.join(repo, "a.go");
    fs.writeFileSync(f, "package main");
    execSync("git add -A && git commit -q -m 'add a.go'", { cwd: repo });

    const ingested = ingest({
      kind: "code/file_snapshot",
      content: "package main",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      kind_specific_meta: { file_path: f },
      schema_version: 1,
    });
    const ok = await runGitAuthorshipExtraction({
      hash: ingested.hash,
      file_path: f,
      project_id: PROJ,
      org_id: ORG,
    });
    expect(ok).toBe(true);

    const db = activeDbFor(ORG);
    const row = db
      .prepare("SELECT kind_specific_meta FROM artifacts WHERE hash = ?")
      .get(ingested.hash) as { kind_specific_meta: string };
    const meta = JSON.parse(row.kind_specific_meta) as {
      git?: { last_author_name: string };
    };
    expect(meta.git?.last_author_name).toBe("Aliceson");
  });
});

describe("phase 5-cont2 — optional-dep fallbacks", () => {
  test("exifr provider returns null without dep (or real provider if installed)", async () => {
    const available = await isExifrAvailable();
    const provider = await createExifrProvider();
    if (available) {
      expect(provider).not.toBeNull();
      expect(provider!.name).toBe("exifr");
    } else {
      expect(provider).toBeNull();
    }
  });

  test("pdf-parse returns null when dep missing", async () => {
    const available = await isPdfParseAvailable();
    if (!available) {
      const result = await extractPdf(Buffer.from("not a pdf"));
      expect(result).toBeNull();
    }
  });

  test("claude-vision providers exist regardless of CLI availability", () => {
    const providers = createClaudeVisionProviders();
    expect(providers.ocr.name).toContain("claude-vision");
    expect(providers.caption.name).toContain("claude-vision");
    expect(providers.scene.name).toContain("claude-vision");
  });

  test("isClaudeCliAvailable boolean probe", async () => {
    const ok = await isClaudeCliAvailable();
    expect(typeof ok).toBe("boolean");
  });
});
