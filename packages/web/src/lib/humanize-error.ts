/**
 * Phase 12 (UI review H1) — central API error humaniser.
 * Maps status codes to plain-English messages.
 */

interface ErrorWithStatus {
  status?: number;
  message?: string;
}

const STATUS_MESSAGES: Record<number, string> = {
  400: "That request was missing or invalid — pick a project and try again.",
  401: "Your session expired. Refresh the page to sign in again.",
  403: "You don't have access to this org or project.",
  404: "That item was already deleted or never existed.",
  409: "Already done — someone else may have got there first.",
  413: "Too much data in one request — try splitting it up.",
  429: "Too many requests — wait a moment and try again.",
  500: "Server error. Check the server log for details.",
  502: "The server is restarting — try again in a moment.",
  503: "The server is busy. Try again in a moment.",
};

function extractStatus(e: unknown): number | null {
  if (typeof e === "object" && e !== null) {
    const r = e as ErrorWithStatus & { statusCode?: number };
    if (typeof r.status === "number") return r.status;
    if (typeof r.statusCode === "number") return r.statusCode;
    if (typeof r.message === "string") {
      const m = /failed:\s*(\d{3})\b/.exec(r.message);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

export function humanizeApiError(e: unknown): string {
  if (e === null || e === undefined) return "Something went wrong.";
  const status = extractStatus(e);
  if (status && STATUS_MESSAGES[status]) {
    return STATUS_MESSAGES[status];
  }
  if (e instanceof Error) {
    if (
      e.message.includes("Failed to fetch") ||
      e.message.includes("NetworkError")
    ) {
      return "Couldn't reach the server. Check your connection and retry.";
    }
    const cleaned = e.message.replace(/^[A-Z]+\s+\/\S+\s+failed:\s*\d{3}\s*/, "");
    return cleaned || e.message;
  }
  return String(e);
}
