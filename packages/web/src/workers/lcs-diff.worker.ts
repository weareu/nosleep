/**
 * Phase 12 (UI review L1) — line-level LCS diff in a Web Worker.
 *
 * Keeps the main thread free during compute. Caller posts a single
 * { type: "diff", a, b } message and waits for either a result frame
 * or a "too_large" frame.
 *
 * Hard cap stays at MAX_DIFF_CELLS to bound memory; below that we run
 * the dp matrix without blocking input.
 */

const MAX_DIFF_CELLS = 4_000_000;

interface DiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
}

interface InitMessage {
  type: "diff";
  a: string;
  b: string;
}

function lineDiff(
  a: string,
  b: string,
): { left: DiffLine[]; right: DiffLine[] } | null {
  const al = a.split("\n");
  const bl = b.split("\n");
  if ((al.length + 1) * (bl.length + 1) > MAX_DIFF_CELLS) return null;

  const m = al.length;
  const n = bl.length;
  const dp: number[][] = Array.from(
    { length: m + 1 },
    () => new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        al[i - 1] === bl[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const left: DiffLine[] = [];
  const right: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (al[i - 1] === bl[j - 1]) {
      left.unshift({ kind: "ctx", text: al[i - 1] });
      right.unshift({ kind: "ctx", text: bl[j - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      left.unshift({ kind: "del", text: al[i - 1] });
      right.unshift({ kind: "ctx", text: "" });
      i--;
    } else {
      left.unshift({ kind: "ctx", text: "" });
      right.unshift({ kind: "add", text: bl[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    left.unshift({ kind: "del", text: al[i - 1] });
    right.unshift({ kind: "ctx", text: "" });
    i--;
  }
  while (j > 0) {
    left.unshift({ kind: "ctx", text: "" });
    right.unshift({ kind: "add", text: bl[j - 1] });
    j--;
  }
  return { left, right };
}

self.onmessage = (e: MessageEvent<InitMessage>) => {
  if (e.data.type !== "diff") return;
  const result = lineDiff(e.data.a, e.data.b);
  const post = (self as unknown as { postMessage: (m: unknown) => void })
    .postMessage;
  if (result === null) {
    post({ type: "too_large", limitCells: MAX_DIFF_CELLS });
    return;
  }
  post({ type: "result", left: result.left, right: result.right });
};

export {};
