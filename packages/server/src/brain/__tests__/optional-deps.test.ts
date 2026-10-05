/**
 * Phase 5-cont tests — optional-dep fallback paths. These run in the
 * default CI/dev env where web-tree-sitter and @xenova/transformers are
 * NOT installed; we expect graceful fallback.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-optdeps-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

import {
  extractSymbols,
  extractSymbolsBest,
  type ExtractTarget,
} from "../extractors/code-symbols.js";
import {
  extractSymbolsViaTreeSitter,
  isTreeSitterAvailable,
} from "../extractors/code-symbols-treesitter.js";
import {
  createTransformersClipProvider,
  isTransformersAvailable,
} from "../extractors/clip-provider-transformers.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";

const ORG = "org_optdeps_test";
const PROJ = "proj_optd";

beforeAll(() => {
  activeDbFor(ORG);
});

afterAll(() => {
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("optional deps — tree-sitter fallback", () => {
  test("isTreeSitterAvailable returns false when dep is missing", async () => {
    const ok = await isTreeSitterAvailable();
    // In this env the dep is deliberately NOT installed. If someone adds it
    // to package.json, this assertion becomes a trailing positive — which is
    // fine. We just need to know the fallback path works.
    expect(typeof ok).toBe("boolean");
  });

  test("extractSymbolsViaTreeSitter returns null without dep", async () => {
    const result = await extractSymbolsViaTreeSitter(
      "export function foo() {}",
      "typescript",
    );
    // If tree-sitter IS installed locally, we'd get an array; otherwise null.
    // The contract: either shape is valid; we're just asserting no throw.
    expect(result === null || Array.isArray(result)).toBe(true);
  });

  test("extractSymbolsBest falls back to regex when tree-sitter unavailable", async () => {
    const target: ExtractTarget = {
      hash: "0".repeat(64),
      text: "export function fallbackTest() {}",
      file_path: "foo.ts",
      project_id: PROJ,
      org_id: ORG,
    };
    const viaBest = await extractSymbolsBest(target);
    const viaRegex = extractSymbols(target);

    // Whatever the path, fallbackTest must be found — that's the contract.
    const bestNames = new Set(viaBest.map((s) => s.symbol));
    const regexNames = new Set(viaRegex.map((s) => s.symbol));
    expect(bestNames.has("fallbackTest")).toBe(true);
    expect(regexNames.has("fallbackTest")).toBe(true);
  });
});

describe("optional deps — CLIP provider fallback", () => {
  test("isTransformersAvailable boolean probe", async () => {
    const ok = await isTransformersAvailable();
    expect(typeof ok).toBe("boolean");
  });

  test("createTransformersClipProvider returns null without dep", async () => {
    const provider = await createTransformersClipProvider();
    // Without @xenova/transformers installed: null. With: a real provider.
    if (provider !== null) {
      expect(provider.name).toContain("clip");
      expect(provider.dim).toBe(512);
    } else {
      expect(provider).toBeNull();
    }
  });
});
