/**
 * Phase 12 — coverage for the assertNonEmpty branches that landed in
 * Phase 11 + 12. Specifically: scope=project + a real project_id is a
 * filter, but scope=project + _org_level is not, and scope=org with
 * nothing is empty.
 */

import { describe, test, expect } from "vitest";
import { QuerySpec, assertNonEmpty } from "../retrieval/query-spec.js";

describe("phase 12 — assertNonEmpty branches", () => {
  test("scope=project + real project_id alone counts as a filter (no throw)", () => {
    const q = QuerySpec.parse({
      org_id: "org_test",
      project_id: "proj_real",
      scope: "project",
    });
    expect(() => assertNonEmpty(q)).not.toThrow();
  });

  test("scope=project + _org_level sentinel throws (project filter is degenerate)", () => {
    const q = QuerySpec.parse({
      org_id: "org_test",
      project_id: "_org_level",
      scope: "project",
    });
    expect(() => assertNonEmpty(q)).toThrow(/empty/);
  });

  test("scope=org + nothing throws (would be unbounded)", () => {
    const q = QuerySpec.parse({
      org_id: "org_test",
      project_id: "proj_real",
      scope: "org",
    });
    expect(() => assertNonEmpty(q)).toThrow(/empty/);
  });

  test("scope=org + temporal range counts as a filter", () => {
    const q = QuerySpec.parse({
      org_id: "org_test",
      project_id: "_org_level",
      scope: "org",
      temporal: { from: 1_000_000 },
    });
    expect(() => assertNonEmpty(q)).not.toThrow();
  });

  test("text query alone is a retriever (any scope)", () => {
    const q = QuerySpec.parse({
      org_id: "org_test",
      project_id: "_org_level",
      scope: "org",
      text: { query: "anything" },
    });
    expect(() => assertNonEmpty(q)).not.toThrow();
  });

  test("kind_prefix facet alone counts as a filter", () => {
    const q = QuerySpec.parse({
      org_id: "org_test",
      project_id: "_org_level",
      scope: "org",
      facets: { kind_prefix: ["conversation/turn/"] },
    });
    expect(() => assertNonEmpty(q)).not.toThrow();
  });
});
