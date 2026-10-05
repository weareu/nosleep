import { describe, it, expect } from "vitest";
import { buildGoalPrompt } from "../../orchestrator/prompt-builder.js";

describe("buildGoalPrompt", () => {
  it("includes the goal verbatim", () => {
    const out = buildGoalPrompt("Refactor the budget pacer", []);
    expect(out).toContain("Refactor the budget pacer");
  });

  it("numbers acceptance criteria starting at 1", () => {
    const out = buildGoalPrompt("g", ["criterion A", "criterion B", "criterion C"]);
    expect(out).toContain("1. criterion A");
    expect(out).toContain("2. criterion B");
    expect(out).toContain("3. criterion C");
  });

  it("includes standard instructions section", () => {
    const out = buildGoalPrompt("g", []);
    expect(out).toContain("# INSTRUCTIONS");
    expect(out).toContain("goal_progress");
    expect(out).toContain("request_help");
  });

  it("works with empty criteria array", () => {
    const out = buildGoalPrompt("g", []);
    expect(out).toContain("# ACCEPTANCE CRITERIA");
    expect(out).toContain("# GOAL");
  });

  it("structure has GOAL → ACCEPTANCE CRITERIA → INSTRUCTIONS in that order", () => {
    const out = buildGoalPrompt("g", ["c"]);
    const goalIdx = out.indexOf("# GOAL");
    const critIdx = out.indexOf("# ACCEPTANCE CRITERIA");
    const instIdx = out.indexOf("# INSTRUCTIONS");
    expect(goalIdx).toBeLessThan(critIdx);
    expect(critIdx).toBeLessThan(instIdx);
  });
});
