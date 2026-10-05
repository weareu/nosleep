import type Database from "better-sqlite3";
import { VALIDATOR_MODEL } from "@nosleep/shared";
import { headlessQuery } from "../lib/headless-claude.js";

interface QuestionContext {
  readonly question: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly orgId: string;
  readonly goalText: string;
}

interface QuestionResponse {
  readonly action: "continue" | "next_task" | "escalate";
  readonly response: string;
}

/**
 * Uses Haiku to classify an agent's question and decide what to do:
 * - "continue" = routine question, tell it to keep working
 * - "next_task" = agent is done or idle, give it the next task
 * - "escalate" = genuine decision point, alert the human
 */
export async function respondToQuestion(
  db: Database.Database,
  ctx: QuestionContext,
): Promise<QuestionResponse> {
  // Get current goal
  const goal = db.prepare(`
    SELECT objective, acceptance_criteria, current_phase, progress_pct
    FROM goals WHERE session_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(ctx.sessionId) as { objective: string; acceptance_criteria: string; current_phase: string; progress_pct: number } | undefined;

  // Get next actionable task from strategy tree
  const nextTask = db.prepare(`
    SELECT sn.id, sn.title, sn.description, sn.acceptance_criteria, sn.type
    FROM strategy_nodes sn
    WHERE sn.project_id = ? AND sn.org_id = ? AND sn.status = 'pending'
    AND sn.id NOT IN (SELECT parent_id FROM strategy_nodes WHERE parent_id IS NOT NULL)
    ORDER BY sn.depth DESC, sn.sort_order ASC LIMIT 1
  `).get(ctx.projectId, ctx.orgId) as { id: string; title: string; description: string; acceptance_criteria: string; type: string } | undefined;

  const prompt = `You are a supervision agent deciding how to respond to an autonomous coding agent's question.

AGENT'S QUESTION: "${ctx.question}"

CURRENT GOAL: ${goal?.objective ?? "No goal set"}
PROGRESS: ${goal?.progress_pct ?? 0}%
PHASE: ${goal?.current_phase ?? "unknown"}

${nextTask ? `NEXT AVAILABLE TASK: [${nextTask.type}] ${nextTask.title} — ${nextTask.description ?? ""}` : "NO NEXT TASK AVAILABLE"}

Classify this into exactly ONE category:

1. CONTINUE — Agent is asking for permission to proceed, confirming an approach, or asking a routine question with an obvious answer. Response: tell it to continue.

2. NEXT_TASK — Agent is done with current work, idle, asking what to do next, or saying it completed something. Response: give it the next task.

3. ESCALATE — Agent is genuinely blocked: missing credentials, conflicting requirements, needs a human business decision, found a critical security issue, or wants to do something destructive. Response: explain why this needs human input.

Respond with ONLY valid JSON:
{"action": "continue" | "next_task" | "escalate", "response": "your response to the agent (1-2 sentences)"}`;

  try {
    const text = await headlessQuery({
      prompt,
      model: VALIDATOR_MODEL,
      timeoutMs: 15_000,
      purpose: "responder",
    });

    return parseResponse(db, text, ctx, nextTask);
  } catch {
    // Haiku failed — default to continue (safe fallback)
    return { action: "continue", response: "Continue autonomously. Make your own decisions." };
  }
}

function parseResponse(
  db: Database.Database,
  stdout: string,
  ctx: QuestionContext,
  nextTask: { id: string; title: string; description: string; acceptance_criteria: string; type: string } | undefined,
): QuestionResponse {
  let text = stdout.trim();
  try {
    const cliResult = JSON.parse(text);
    if (cliResult.result) text = cliResult.result;
  } catch { /* not CLI wrapper */ }

  // Find JSON in response
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    return { action: "continue", response: "Continue autonomously." };
  }

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { action?: string; response?: string };
    const action = (["continue", "next_task", "escalate"].includes(parsed.action ?? ""))
      ? parsed.action as "continue" | "next_task" | "escalate"
      : "continue";

    if (action === "next_task" && nextTask) {
      let criteria: string[] = [];
      try { criteria = JSON.parse(nextTask.acceptance_criteria); } catch { /* */ }
      const criteriaText = criteria.length > 0
        ? "\nAcceptance Criteria:\n" + criteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")
        : "";

      return {
        action: "next_task",
        response: `${parsed.response ?? "Moving to next task."}\n\nNEXT TASK:\n[${nextTask.type}] ${nextTask.title}\n${nextTask.description ?? ""}${criteriaText}\n\nCall nosleep(action="strategy_update", params={nodeId:"${nextTask.id}", status:"in_progress"}) then begin.`,
      };
    }

    if (action === "escalate") {
      // Create alert for the human
      db.prepare(`INSERT INTO alerts (org_id, session_id, type, severity, message) VALUES (?, ?, 'question', 'warning', ?)`)
        .run(ctx.orgId, ctx.sessionId, `Agent needs decision: ${ctx.question.slice(0, 200)}`);

      return {
        action: "escalate",
        response: `${parsed.response ?? "This needs human input."} Your question has been escalated. Call request_help with more details if needed, then continue with other work while waiting.`,
      };
    }

    return {
      action: "continue",
      response: parsed.response ?? "Continue autonomously. Make your own decisions.",
    };
  } catch {
    return { action: "continue", response: "Continue autonomously." };
  }
}
