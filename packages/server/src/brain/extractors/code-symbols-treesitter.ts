/**
 * Tree-sitter code symbol extractor using web-tree-sitter v0.20 + the
 * grammars bundled in tree-sitter-wasms. v0.20 ships Parser as a default
 * export with Parser.Language.load() as the grammar loader.
 *
 * Falls back to null when web-tree-sitter or tree-sitter-wasms aren't
 * resolvable, so the regex extractor in code-symbols.ts handles the gap.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { CodeSymbol, SymbolKind } from "./code-symbols.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

interface TsLanguage {}

interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: TsNode[];
  childForFieldName?: (name: string) => TsNode | null;
}

interface TsTree {
  rootNode: TsNode;
}

interface TsParser {
  setLanguage(lang: TsLanguage): void;
  parse(src: string): TsTree;
}

interface ParserCtor {
  init(): Promise<void>;
  new (): TsParser;
  Language: {
    load(wasmPathOrBuffer: string | Uint8Array): Promise<TsLanguage>;
  };
}

type LoadedState = {
  ok: boolean;
  ParserCtor: ParserCtor | null;
  grammars: Map<string, TsLanguage>;
};

let loadPromise: Promise<LoadedState> | null = null;

function findWasmsDir(): string | null {
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "node_modules", "tree-sitter-wasms", "out");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const pkgJson = requireFromHere.resolve("tree-sitter-wasms/package.json");
    return path.join(path.dirname(pkgJson), "out");
  } catch {
    return null;
  }
}

const LANGUAGES_TO_LOAD = [
  "typescript",
  "tsx",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "ruby",
];

async function tryLoad(): Promise<LoadedState> {
  const grammars = new Map<string, TsLanguage>();
  let Parser: ParserCtor;
  try {
    const mod = (await import("web-tree-sitter")) as unknown as {
      default: ParserCtor;
    };
    Parser = mod.default;
    if (typeof Parser?.init !== "function") {
      return { ok: false, ParserCtor: null, grammars };
    }
    await Parser.init();
  } catch {
    return { ok: false, ParserCtor: null, grammars };
  }

  const wasmsDir = findWasmsDir();
  if (!wasmsDir) {
    return { ok: false, ParserCtor: null, grammars };
  }

  for (const lang of LANGUAGES_TO_LOAD) {
    const fpath = path.join(wasmsDir, `tree-sitter-${lang}.wasm`);
    if (!fs.existsSync(fpath)) continue;
    try {
      const grammar = await Parser.Language.load(fpath);
      grammars.set(lang, grammar);
    } catch {
      /* skip individual grammar failures */
    }
  }

  return { ok: grammars.size > 0, ParserCtor: Parser, grammars };
}

function state(): Promise<LoadedState> {
  if (!loadPromise) loadPromise = tryLoad();
  return loadPromise;
}

const LANG_MAP: Record<string, string[]> = {
  typescript: ["typescript", "tsx"],
  javascript: ["javascript"],
  python: ["python"],
  go: ["go"],
  rust: ["rust"],
  java: ["java"],
  ruby: ["ruby"],
};

export async function extractSymbolsViaTreeSitter(
  text: string,
  language: string,
): Promise<CodeSymbol[] | null> {
  const s = await state();
  if (!s.ok || !s.ParserCtor) return null;

  const candidates = LANG_MAP[language] ?? [language];
  let grammar: TsLanguage | null = null;
  for (const c of candidates) {
    if (s.grammars.has(c)) {
      grammar = s.grammars.get(c)!;
      break;
    }
  }
  if (!grammar) return null;

  try {
    const parser = new s.ParserCtor();
    parser.setLanguage(grammar);
    const tree = parser.parse(text);
    return walkTree(tree.rootNode, language);
  } catch {
    return null;
  }
}

function walkTree(root: TsNode, language: string): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  function visit(node: TsNode, depth: number): void {
    const symbol = symbolFromNode(node, language);
    if (symbol) out.push(symbol);
    if (depth > 12) return;
    for (const child of node.children) visit(child, depth + 1);
  }
  visit(root, 0);
  return out;
}

function symbolFromNode(node: TsNode, language: string): CodeSymbol | null {
  const kind = tsNodeKind(node.type);
  if (!kind) return null;

  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  if (kind === "import") {
    const source = extractImportSource(node);
    if (!source) return null;
    return {
      symbol: source,
      symbol_kind: "import",
      line_start: startLine,
      line_end: endLine,
      language,
    };
  }

  const nameText = findNameDescendant(node);
  if (!nameText) return null;
  return {
    symbol: nameText,
    symbol_kind: kind,
    line_start: startLine,
    line_end: endLine,
    language,
  };
}

function findNameDescendant(node: TsNode): string | null {
  if (typeof node.childForFieldName === "function") {
    const named = node.childForFieldName("name");
    if (named?.text) return named.text;
  }
  const stack = [...node.children];
  while (stack.length > 0) {
    const n = stack.shift()!;
    if (
      n.type === "identifier" ||
      n.type === "type_identifier" ||
      n.type === "property_identifier" ||
      n.type === "constant"
    ) {
      return n.text;
    }
    if (
      n.type === "block" ||
      n.type === "class_body" ||
      n.type === "object" ||
      n.type === "function_body"
    )
      continue;
    stack.push(...n.children);
  }
  return null;
}

function tsNodeKind(type: string): SymbolKind | null {
  switch (type) {
    case "function_declaration":
    case "method_definition":
    case "function_definition":
    case "method_declaration":
    case "function_item":
    case "method":
      return "function";
    case "class_declaration":
    case "class_definition":
      return "class";
    case "interface_declaration":
    case "trait_item":
      return "interface";
    case "type_alias_declaration":
    case "type_declaration":
      return "type";
    case "enum_declaration":
    case "enum_item":
      return "enum";
    case "import_statement":
    case "import_from_statement":
    case "import_declaration":
    case "use_declaration":
    case "import_spec":
      return "import";
    case "struct_item":
      return "class";
    default:
      return null;
  }
}

function extractImportSource(node: TsNode): string | null {
  const stack = [...node.children];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (
      n.type === "string" ||
      n.type === "string_literal" ||
      n.type === "interpreted_string_literal"
    ) {
      return n.text.replace(/^["'`]|["'`]$/g, "");
    }
    stack.push(...n.children);
  }
  return null;
}

export async function isTreeSitterAvailable(): Promise<boolean> {
  const s = await state();
  return s.ok;
}
