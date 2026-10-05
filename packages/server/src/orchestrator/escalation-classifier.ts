/**
 * Classifies questions from Claude sessions as routine (auto-continue) or
 * critical (escalate to human).
 *
 * Uses pattern matching first (fast path), then falls back to simple heuristics.
 * No LLM call — keeps it cheap and fast.
 */

export type EscalationLevel = "auto" | "escalate";

export interface ClassificationResult {
  readonly level: EscalationLevel;
  readonly reason: string;
  readonly confidence: number; // 0-1
}

// Patterns that indicate routine questions (safe to auto-continue)
const ROUTINE_PATTERNS = [
  /\bwhich (?:test framework|linter|formatter|style)\b/i,
  /\bshould I (?:use|add|include|import)\b/i,
  /\bwould you (?:like|prefer) (?:me to|if I)\b/i,
  /\bdo you want me to (?:continue|proceed|go ahead)\b/i,
  /\bshall I (?:continue|proceed|go ahead)\b/i,
  /\bcontinue\?/i,
  /\bproceed\?/i,
  /\bis (?:this|that) (?:ok|okay|correct|right)\?/i,
  /\blooks? good\?/i,
  /\bready to (?:test|commit|push|deploy)\?/i,
];

// Patterns that indicate critical decisions (need human input)
const CRITICAL_PATTERNS = [
  /\bdelete\b.*\b(?:database|production|prod|all|entire)\b/i,
  /\bdrop\b.*\b(?:table|database|collection)\b/i,
  /\bforce.?push\b/i,
  /\breset\s+--hard\b/i,
  /\bformat\b.*\b(?:disk|drive|partition)\b/i,
  /\b(?:api.?key|secret|password|credential|token)\b.*\b(?:expose|public|commit|hardcode)\b/i,
  /\b(?:expose|public)\b.*\b(?:api.?key|secret|password|credential|token)\b/i,
  /\bbreak(?:ing)?\s+change\b/i,
  /\bbackward.?compat/i,
  /\bmigrat(?:e|ion)\b.*\b(?:production|prod|live)\b/i,
  /\bpayment|billing|charge|refund\b/i,
  /\bpermission|authorization|auth\b.*\b(?:remove|delete|change|modify)\b/i,
  /\b(?:remove|delete|change|modify)\b.*\b(?:permission|authorization|auth)\b/i,
  /\bI'm (?:not sure|uncertain|confused|stuck)\b/i,
  /\bI don'?t (?:know|understand)\b/i,
  /\b(?:critical|severe|fatal|dangerous)\b/i,
  /\bdata loss\b/i,
  /\birreversible\b/i,
];

// Patterns that indicate the question is about architecture/design (escalate)
const DESIGN_PATTERNS = [
  /\b(?:architecture|architect)\b/i,
  /\b(?:redesign|refactor|rewrite)\b.*\b(?:entire|whole|all)\b/i,
  /\b(?:approach|strategy|direction)\b.*\?\s*$/i,
  /\btrade.?off\b/i,
  /\bfundamental\b/i,
];

/**
 * Classify a question from a Claude session.
 */
export function classifyQuestion(
  questionText: string,
  context?: {
    /** Project autonomy level */
    readonly autonomyLevel?: "full" | "supervised" | "manual";
    /** How many tool calls have been made in this session */
    readonly toolCallCount?: number;
    /** Current goal text for relevance checking */
    readonly goalText?: string;
  },
): ClassificationResult {
  const text = questionText.trim();

  // Manual mode: always escalate
  if (context?.autonomyLevel === "manual") {
    return { level: "escalate", reason: "Manual autonomy mode", confidence: 1.0 };
  }

  // Check critical patterns first (higher priority)
  for (const pattern of CRITICAL_PATTERNS) {
    if (pattern.test(text)) {
      return {
        level: "escalate",
        reason: `Critical pattern: ${pattern.source}`,
        confidence: 0.9,
      };
    }
  }

  // Design questions escalate in supervised mode
  if (context?.autonomyLevel === "supervised") {
    for (const pattern of DESIGN_PATTERNS) {
      if (pattern.test(text)) {
        return {
          level: "escalate",
          reason: `Design decision in supervised mode: ${pattern.source}`,
          confidence: 0.8,
        };
      }
    }
  }

  // Check routine patterns
  for (const pattern of ROUTINE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        level: "auto",
        reason: `Routine pattern: ${pattern.source}`,
        confidence: 0.85,
      };
    }
  }

  // Heuristic: short questions with "?" are usually routine confirmation requests
  if (text.length < 100 && text.endsWith("?")) {
    return { level: "auto", reason: "Short confirmation question", confidence: 0.6 };
  }

  // Heuristic: long questions with multiple "?" often indicate genuine uncertainty
  const questionMarks = (text.match(/\?/g) ?? []).length;
  if (questionMarks >= 3 || text.length > 500) {
    return { level: "escalate", reason: "Complex multi-part question", confidence: 0.7 };
  }

  // Full autonomy mode: default to auto-continue
  if (context?.autonomyLevel === "full") {
    return { level: "auto", reason: "Full autonomy mode default", confidence: 0.5 };
  }

  // Default: auto-continue for simple questions, escalate for anything uncertain
  return { level: "auto", reason: "Default: simple question", confidence: 0.5 };
}
