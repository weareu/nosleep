/**
 * Helpers for rendering possibly-JSON text as something human-readable.
 *
 * Brain snippets and hook payloads are often raw (sometimes TRUNCATED) JSON
 * like `{"tool_name":"Bash","tool_input":{"command":"...","description":"..."}}`.
 * Dumping that at the user is noise — these helpers pull out the meaningful
 * "name" fields so lists can show `Bash — Deploy the issues auth fix` instead.
 */

/** Fields that best describe a JSON payload, in priority order. */
const LABEL_FIELDS = [
  "description",
  "title",
  "question",
  "summary",
  "message",
  "name",
  "subject",
  "goal",
  "label",
  "prompt",
  "query",
  "command",
  "file_path",
  "text",
  "content",
] as const;

/** Fields naming the acting thing (shown as a prefix badge when present). */
const KIND_FIELDS = ["tool_name", "tool", "type", "kind", "action", "event"] as const;

export function looksLikeJson(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

/** Parse if valid JSON; returns undefined on failure (e.g. truncated). */
export function tryParseJson(s: string): unknown | undefined {
  if (!looksLikeJson(s)) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Un-escape a JSON string literal body (used by the regex fallback). */
function unescapeJsonString(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s.replace(/\\"/g, '"').replace(/\\n/g, " ").replace(/\\\\/g, "\\");
  }
}

/** Regex-extract `"field":"value"` from a (possibly truncated) JSON string. */
function regexField(s: string, field: string): string | undefined {
  const m = s.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  return m ? unescapeJsonString(m[1]) : undefined;
}

function firstStringField(
  obj: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

export interface SmartLabel {
  /** Short acting-thing prefix, e.g. "Bash" for a tool call. */
  kind?: string;
  /** The human-meaningful one-liner extracted from the payload. */
  label: string;
  /** True when the source text was JSON(-ish) rather than prose. */
  fromJson: boolean;
}

/**
 * Produce a one-line human label for arbitrary snippet text.
 *  - Valid JSON object → name field (+ tool/kind prefix), searching one
 *    level of nesting (tool_input etc.) too.
 *  - Truncated JSON → regex fallback over the same fields.
 *  - Prose → returned as-is (markdown syntax lightly stripped).
 */
export function smartLabel(text: string): SmartLabel {
  const trimmed = text.trim();
  if (!looksLikeJson(trimmed)) {
    return { label: stripMarkdownSyntax(trimmed), fromJson: false };
  }

  const parsed = tryParseJson(trimmed);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const kind = firstStringField(obj, KIND_FIELDS);
    let label = firstStringField(obj, LABEL_FIELDS);
    if (!label) {
      // One level of nesting: tool_input / payload / data commonly hold the
      // meaningful fields.
      for (const v of Object.values(obj)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          label = firstStringField(v as Record<string, unknown>, LABEL_FIELDS);
          if (label) break;
        }
      }
    }
    if (kind || label) {
      return { kind, label: label ?? "", fromJson: true };
    }
    return { label: trimmed, fromJson: true };
  }

  // Truncated / invalid JSON — regex fallback.
  const kind = KIND_FIELDS.map((f) => regexField(trimmed, f)).find(Boolean);
  const label = LABEL_FIELDS.map((f) => regexField(trimmed, f)).find(Boolean);
  if (kind || label) {
    return { kind, label: label ?? "", fromJson: true };
  }
  return { label: trimmed, fromJson: true };
}

/** Light one-line markdown cleanup for list rows (## **Bold** → Bold). */
export function stripMarkdownSyntax(s: string): string {
  return s
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}
