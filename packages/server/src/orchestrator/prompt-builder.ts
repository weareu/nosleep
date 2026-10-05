/**
 * Goal/system prompt assembly. Pure functions — no DB or filesystem access.
 */

/**
 * Build the user-facing goal prompt that gets sent to Claude on session launch.
 * Contains the goal, acceptance criteria, and standard instructions.
 */
export function buildGoalPrompt(goal: string, criteria: readonly string[]): string {
  const criteriaText = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    `# GOAL`,
    goal,
    ``,
    `# ACCEPTANCE CRITERIA`,
    criteriaText,
    ``,
    `# INSTRUCTIONS`,
    `- Complete ALL acceptance criteria fully. No stubs, no TODOs, no placeholders.`,
    `- Call goal_progress after each major milestone.`,
    `- If blocked, call request_help instead of guessing.`,
    `- Stay focused on this goal only. Do not work on unrelated tasks.`,
    `- When finished, verify all criteria are met before stopping.`,
  ].join("\n");
}
