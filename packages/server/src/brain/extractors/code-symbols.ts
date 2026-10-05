/**
 * Regex-based code symbol extractor. Stopgap until tree-sitter lands (Phase
 * 5 P2). Covers the ~80% case for TS/JS/TSX/JSX/Py/Go/Rust by matching
 * top-level function/class/import/type declarations.
 *
 * The goal isn't parse fidelity — it's "searchable symbol index". Fancy
 * cases (destructured exports, namespace imports, Go generics, etc.) fall
 * through silently; tree-sitter will catch them later.
 */

import { nanoid } from "nanoid";
import { activeDbFor } from "../storage/active-db.js";

export type SymbolKind =
  | "function"
  | "class"
  | "import"
  | "type"
  | "variable"
  | "interface"
  | "enum";

export interface CodeSymbol {
  symbol: string;
  symbol_kind: SymbolKind;
  line_start?: number;
  line_end?: number;
  language: string;
}

export interface ExtractTarget {
  hash: string;
  text: string;
  file_path?: string;
  language?: string;
  project_id: string;
  org_id: string;
}

const LANG_FROM_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
};

function inferLanguage(target: ExtractTarget): string {
  if (target.language) return target.language.toLowerCase();
  const path = target.file_path ?? "";
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "unknown";
  const ext = path.slice(dot + 1).toLowerCase();
  return LANG_FROM_EXT[ext] ?? "unknown";
}

export function extractSymbols(target: ExtractTarget): CodeSymbol[] {
  const lang = inferLanguage(target);
  switch (lang) {
    case "typescript":
    case "javascript":
      return extractJsTsSymbols(target.text, lang);
    case "python":
      return extractPythonSymbols(target.text);
    case "go":
      return extractGoSymbols(target.text);
    case "rust":
      return extractRustSymbols(target.text);
    default:
      return [];
  }
}

/**
 * Extract symbols. Tries tree-sitter first (real AST); falls back to regex
 * when the optional dep isn't installed or no grammar matches.
 */
export async function extractSymbolsBest(
  target: ExtractTarget,
): Promise<CodeSymbol[]> {
  const lang = inferLanguage(target);
  try {
    const mod = await import("./code-symbols-treesitter.js");
    const ast = await mod.extractSymbolsViaTreeSitter(target.text, lang);
    if (ast) return ast;
  } catch {
    /* tree-sitter path unavailable — fall through to regex */
  }
  return extractSymbols(target);
}

/** Sync variant: regex-only. Used by tests and backfill tools that can't await. */
export function runCodeSymbolExtraction(target: ExtractTarget): boolean {
  return runWithSymbols(target, extractSymbols(target));
}

/** Async variant: tree-sitter when available, regex fallback. Used by the async worker. */
export async function runCodeSymbolExtractionAsync(
  target: ExtractTarget,
): Promise<boolean> {
  const symbols = await extractSymbolsBest(target);
  return runWithSymbols(target, symbols);
}

function runWithSymbols(target: ExtractTarget, symbols: CodeSymbol[]): boolean {
  const started = performance.now();
  const db = activeDbFor(target.org_id);

  // Already extracted? idempotency guard
  const existing = db
    .prepare(`SELECT COUNT(*) AS c FROM code_symbols WHERE hash = ?`)
    .get(target.hash) as { c: number };
  if (existing.c > 0) {
    recordRun(target, started, "skipped", "already extracted");
    return true;
  }

  if (symbols.length === 0) {
    recordRun(target, started, "skipped", `no symbols for ${inferLanguage(target)}`);
    return false;
  }

  const lang = inferLanguage(target);
  const insert = db.prepare(
    `INSERT INTO code_symbols (hash, file_path, symbol, symbol_kind, line_start, line_end, language)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const s of symbols) {
      insert.run(
        target.hash,
        target.file_path ?? null,
        s.symbol,
        s.symbol_kind,
        s.line_start ?? null,
        s.line_end ?? null,
        lang,
      );
    }
  });
  tx();

  recordRun(target, started, "success", `${symbols.length} symbols`);
  return true;
}

function recordRun(
  target: ExtractTarget,
  started: number,
  result: "success" | "failed" | "skipped",
  note: string,
): void {
  const db = activeDbFor(target.org_id);
  try {
    db.prepare(
      `INSERT INTO extractor_runs
       (run_id, ts, extractor, extractor_version, prompt_version, model,
        artifact_hash, duration_ms, result, error,
        project_id, org_id)
       VALUES (?, ?, 'code_symbols_regex', '0.1.0', NULL, NULL, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nanoid(),
      Math.floor(Date.now() / 1000),
      target.hash,
      performance.now() - started,
      result,
      note,
      target.project_id,
      target.org_id,
    );
  } catch {
    /* audit best-effort */
  }
}

// ── Per-language regex extractors ────────────────────────

function lineNumOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text[i] === "\n") line++;
  return line;
}

function extractJsTsSymbols(text: string, lang: string): CodeSymbol[] {
  const out: CodeSymbol[] = [];

  // Skip import source strings when they match our generic name regex later.
  // Functions: function foo, async function foo, export function foo
  for (const m of text.matchAll(
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  )) {
    out.push({
      symbol: m[1],
      symbol_kind: "function",
      line_start: lineNumOf(text, m.index ?? 0),
      language: lang,
    });
  }

  // Arrow functions: const foo = (...) =>    /    const foo: T = (...) =>
  for (const m of text.matchAll(
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g,
  )) {
    out.push({
      symbol: m[1],
      symbol_kind: "function",
      line_start: lineNumOf(text, m.index ?? 0),
      language: lang,
    });
  }

  // Classes
  for (const m of text.matchAll(
    /(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  )) {
    out.push({
      symbol: m[1],
      symbol_kind: "class",
      line_start: lineNumOf(text, m.index ?? 0),
      language: lang,
    });
  }

  // Interfaces (TS)
  if (lang === "typescript") {
    for (const m of text.matchAll(
      /(?:^|\n)\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g,
    )) {
      out.push({
        symbol: m[1],
        symbol_kind: "interface",
        line_start: lineNumOf(text, m.index ?? 0),
        language: lang,
      });
    }
    // Type aliases
    for (const m of text.matchAll(
      /(?:^|\n)\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g,
    )) {
      out.push({
        symbol: m[1],
        symbol_kind: "type",
        line_start: lineNumOf(text, m.index ?? 0),
        language: lang,
      });
    }
    // Enums
    for (const m of text.matchAll(
      /(?:^|\n)\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/g,
    )) {
      out.push({
        symbol: m[1],
        symbol_kind: "enum",
        line_start: lineNumOf(text, m.index ?? 0),
        language: lang,
      });
    }
  }

  // Imports — record source path as the symbol
  for (const m of text.matchAll(/import\s+[^;"']+from\s+["']([^"']+)["']/g)) {
    out.push({
      symbol: m[1],
      symbol_kind: "import",
      line_start: lineNumOf(text, m.index ?? 0),
      language: lang,
    });
  }

  return out;
}

function extractPythonSymbols(text: string): CodeSymbol[] {
  const out: CodeSymbol[] = [];

  for (const m of text.matchAll(
    /(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/g,
  )) {
    out.push({
      symbol: m[1],
      symbol_kind: "function",
      line_start: lineNumOf(text, m.index ?? 0),
      language: "python",
    });
  }
  for (const m of text.matchAll(/(?:^|\n)\s*class\s+([A-Za-z_][\w]*)/g)) {
    out.push({
      symbol: m[1],
      symbol_kind: "class",
      line_start: lineNumOf(text, m.index ?? 0),
      language: "python",
    });
  }
  for (const m of text.matchAll(
    /(?:^|\n)\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g,
  )) {
    const mod = m[1] ?? m[2];
    if (mod) {
      out.push({
        symbol: mod,
        symbol_kind: "import",
        line_start: lineNumOf(text, m.index ?? 0),
        language: "python",
      });
    }
  }
  return out;
}

function extractGoSymbols(text: string): CodeSymbol[] {
  const out: CodeSymbol[] = [];

  // func Name(...)  AND  func (r Recv) Name(...)
  for (const m of text.matchAll(
    /(?:^|\n)func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)\s*\(/g,
  )) {
    out.push({
      symbol: m[1],
      symbol_kind: "function",
      line_start: lineNumOf(text, m.index ?? 0),
      language: "go",
    });
  }
  // type Name struct / interface
  for (const m of text.matchAll(
    /(?:^|\n)type\s+([A-Za-z_][\w]*)\s+(struct|interface|=)/g,
  )) {
    out.push({
      symbol: m[1],
      symbol_kind: m[2] === "interface" ? "interface" : "type",
      line_start: lineNumOf(text, m.index ?? 0),
      language: "go",
    });
  }
  // import "path/to/pkg"
  for (const m of text.matchAll(/import\s+(?:"([^"]+)"|\(\s*([\s\S]*?)\s*\))/g)) {
    if (m[1]) {
      out.push({
        symbol: m[1],
        symbol_kind: "import",
        line_start: lineNumOf(text, m.index ?? 0),
        language: "go",
      });
    } else if (m[2]) {
      for (const im of m[2].matchAll(/"([^"]+)"/g)) {
        out.push({
          symbol: im[1],
          symbol_kind: "import",
          line_start: lineNumOf(text, m.index ?? 0),
          language: "go",
        });
      }
    }
  }
  return out;
}

function extractRustSymbols(text: string): CodeSymbol[] {
  const out: CodeSymbol[] = [];

  for (const m of text.matchAll(
    /(?:^|\n)\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/g,
  )) {
    out.push({
      symbol: m[1],
      symbol_kind: "function",
      line_start: lineNumOf(text, m.index ?? 0),
      language: "rust",
    });
  }
  for (const m of text.matchAll(
    /(?:^|\n)\s*(?:pub(?:\([^)]+\))?\s+)?struct\s+([A-Za-z_][\w]*)/g,
  )) {
    out.push({
      symbol: m[1],
      symbol_kind: "class",
      line_start: lineNumOf(text, m.index ?? 0),
      language: "rust",
    });
  }
  for (const m of text.matchAll(
    /(?:^|\n)\s*(?:pub(?:\([^)]+\))?\s+)?enum\s+([A-Za-z_][\w]*)/g,
  )) {
    out.push({
      symbol: m[1],
      symbol_kind: "enum",
      line_start: lineNumOf(text, m.index ?? 0),
      language: "rust",
    });
  }
  for (const m of text.matchAll(
    /(?:^|\n)\s*(?:pub(?:\([^)]+\))?\s+)?trait\s+([A-Za-z_][\w]*)/g,
  )) {
    out.push({
      symbol: m[1],
      symbol_kind: "interface",
      line_start: lineNumOf(text, m.index ?? 0),
      language: "rust",
    });
  }
  for (const m of text.matchAll(
    /(?:^|\n)\s*use\s+([\w:]+(?:::\{[^}]+\})?);/g,
  )) {
    out.push({
      symbol: m[1],
      symbol_kind: "import",
      line_start: lineNumOf(text, m.index ?? 0),
      language: "rust",
    });
  }
  return out;
}
