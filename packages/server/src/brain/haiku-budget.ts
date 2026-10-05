/**
 * Circuit breaker for brain Haiku spawns.
 *
 * After the 2026-05-18 incident (104 concurrent recursive Haiku procs
 * consumed 80%+ of the user's account budget), every brain spawner must
 * gate through here. Behaviour:
 *
 *   - Sliding 60s window of spawn timestamps.
 *   - SOFT cap (default 60/min): canSpawn() returns false, callers
 *     gracefully return null. No user impact except brain stalling.
 *   - HARD cap (default 200/min): trips the kill switch by setting
 *     process.env.NOSLEEP_BRAIN_DISABLE_TRIAGE = "1", which is honoured
 *     by every spawner at entry. Recovery requires a server restart so
 *     a human is in the loop.
 *
 * Tunable via env: NOSLEEP_BRAIN_SOFT_LIMIT, NOSLEEP_BRAIN_HARD_LIMIT.
 */

const WINDOW_MS = 60_000;
const SOFT_LIMIT = parseInt(process.env.NOSLEEP_BRAIN_SOFT_LIMIT ?? "60", 10);
const HARD_LIMIT = parseInt(process.env.NOSLEEP_BRAIN_HARD_LIMIT ?? "200", 10);

const timestamps: number[] = [];
let tripped = false;

function prune(now: number): void {
  const cutoff = now - WINDOW_MS;
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }
}

export function canSpawnHaiku(): boolean {
  if (tripped) return false;
  if (process.env.NOSLEEP_BRAIN_DISABLE_TRIAGE === "1") return false;
  const now = Date.now();
  prune(now);
  return timestamps.length < SOFT_LIMIT;
}

export function recordHaikuSpawn(): void {
  const now = Date.now();
  prune(now);
  timestamps.push(now);
  if (timestamps.length >= HARD_LIMIT && !tripped) {
    tripped = true;
    process.env.NOSLEEP_BRAIN_DISABLE_TRIAGE = "1";
    // eslint-disable-next-line no-console
    console.error(
      `[brain-budget] HARD LIMIT TRIPPED: ${timestamps.length} Haiku spawns in ${WINDOW_MS}ms. ` +
        `Auto-disabling triage. Restart server after investigation.`,
    );
  }
}

export function haikuBudgetSnapshot(): {
  spawnsInWindow: number;
  softLimit: number;
  hardLimit: number;
  tripped: boolean;
} {
  prune(Date.now());
  return {
    spawnsInWindow: timestamps.length,
    softLimit: SOFT_LIMIT,
    hardLimit: HARD_LIMIT,
    tripped,
  };
}
