import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { readdir, stat as statAsync } from "node:fs/promises";
import { join, extname, relative } from "node:path";
import { embed, embedBatch } from "./embedder.js";
import { getLogger } from "../logger.js";

const log = getLogger("vector-indexer");

// ── Types ──────────────────────────────────────────────

export interface SearchResult {
  readonly filePath: string;
  readonly heading: string | null;
  readonly content: string;
  readonly chunkType: string;
  readonly distance: number;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  readonly projectId: string;
}

interface ChunkInput {
  readonly filePath: string;
  readonly chunkType: string;
  readonly heading: string | null;
  readonly content: string;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
}

// ── Constants ──────────────────────────────────────────

const INDEXABLE_EXTENSIONS = new Set([
  ".md", ".html", ".ts", ".js", ".tsx", ".jsx",
  ".py", ".rs", ".go", ".cs",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next",
  ".expo", ".cache", "__pycache__", ".tsbuildinfo",
]);

const SKIP_PATTERNS = [".lock", ".min.js", ".min.css", ".map"];

const CODE_CHUNK_LINES = 50;
const CODE_OVERLAP_LINES = 10;
const MAX_FILE_SIZE = 500_000; // 500KB

// Bound the work per project. A checked-out monorepo or vendored tree (e.g.
// the Linux kernel = 79k indexable files) would otherwise produce hundreds of
// thousands of chunks — minutes of CPU and an enormous vector table. The cap
// is logged loudly so a truncated index is never mistaken for a complete one.
export const MAX_FILES_PER_PROJECT = 5000;

// Yield to the event loop every N directory entries during the walk. Without
// this the recursive walk of a large tree blocks the loop for minutes (a 206s
// freeze on the kernel tree), timing out /health and triggering the watchdog
// kill→restart→re-walk loop. setImmediate lets pending HTTP requests (/health)
// run between batches of entries.
const WALK_YIELD_EVERY = 1000;

// ── Helpers ────────────────────────────────────────────

function fileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export interface WalkResult {
  readonly files: string[];
  readonly capped: boolean;
}

/**
 * Async, event-loop-friendly directory walk. Iterative (explicit stack, no
 * recursion), uses Dirent metadata to avoid a stat() per entry, yields to the
 * loop every WALK_YIELD_EVERY entries, and stops at MAX_FILES_PER_PROJECT.
 */
export async function walkDir(root: string): Promise<WalkResult> {
  const results: string[] = [];
  if (!existsSync(root)) return { files: results, capped: false };

  const stack: string[] = [root];
  let processed = 0;
  let capped = false;

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (++processed % WALK_YIELD_EVERY === 0) {
        await new Promise((r) => setImmediate(r));
      }

      const name = entry.name;
      if (name.startsWith(".")) continue;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        stack.push(join(dir, name));
      } else if (entry.isFile()) {
        const ext = extname(name).toLowerCase();
        if (!INDEXABLE_EXTENSIONS.has(ext)) continue;
        if (SKIP_PATTERNS.some((p) => name.endsWith(p))) continue;

        const fullPath = join(dir, name);
        let size: number;
        try {
          size = (await statAsync(fullPath)).size;
        } catch {
          continue;
        }
        if (size > MAX_FILE_SIZE) continue;

        results.push(fullPath);
        if (results.length >= MAX_FILES_PER_PROJECT) {
          capped = true;
          return { files: results, capped };
        }
      }
    }
  }

  return { files: results, capped };
}

// ── Chunking Strategies ────────────────────────────────

function chunkMarkdown(content: string, filePath: string): ChunkInput[] {
  const chunks: ChunkInput[] = [];
  const lines = content.split("\n");

  let currentHeading: string | null = null;
  let currentLines: string[] = [];
  let headingLineStart = 0;

  function flush(): void {
    const text = currentLines.join("\n").trim();
    if (text.length > 20) {
      chunks.push({
        filePath,
        chunkType: "doc",
        heading: currentHeading,
        content: text.slice(0, 2000),
        lineStart: headingLineStart + 1,
        lineEnd: headingLineStart + currentLines.length,
      });
    }
    currentLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,3} /.test(line)) {
      flush();
      currentHeading = line.replace(/^#+\s*/, "").trim();
      headingLineStart = i;
    }
    currentLines.push(line);
  }
  flush();

  // If no headings found, treat entire file as one chunk
  if (chunks.length === 0 && content.trim().length > 20) {
    chunks.push({
      filePath,
      chunkType: "doc",
      heading: null,
      content: content.trim().slice(0, 2000),
      lineStart: 1,
      lineEnd: lines.length,
    });
  }

  return chunks;
}

function chunkHtml(content: string, filePath: string): ChunkInput[] {
  // Strip HTML tags, split by heading tags
  const stripped = content
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (stripped.length < 20) return [];

  // Split into ~200 word chunks
  const words = stripped.split(/\s+/);
  const chunks: ChunkInput[] = [];
  const chunkSize = 200;

  for (let i = 0; i < words.length; i += chunkSize) {
    const slice = words.slice(i, i + chunkSize).join(" ");
    if (slice.length > 20) {
      chunks.push({
        filePath,
        chunkType: "html",
        heading: null,
        content: slice.slice(0, 2000),
        lineStart: null,
        lineEnd: null,
      });
    }
  }

  return chunks;
}

function chunkCode(content: string, filePath: string): ChunkInput[] {
  const lines = content.split("\n");
  const chunks: ChunkInput[] = [];

  for (let i = 0; i < lines.length; i += CODE_CHUNK_LINES - CODE_OVERLAP_LINES) {
    const end = Math.min(i + CODE_CHUNK_LINES, lines.length);
    const slice = lines.slice(i, end).join("\n").trim();
    if (slice.length > 30) {
      // Try to extract a heading from function/class declarations
      let heading: string | null = null;
      for (const line of lines.slice(i, end)) {
        const match = line.match(
          /(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|def|fn|func|struct|enum)\s+(\w+)/
        );
        if (match) {
          heading = match[1];
          break;
        }
      }

      chunks.push({
        filePath,
        chunkType: "code",
        heading,
        content: slice.slice(0, 2000),
        lineStart: i + 1,
        lineEnd: end,
      });
    }
  }

  return chunks;
}

function chunkFile(content: string, filePath: string, ext: string): ChunkInput[] {
  if (ext === ".md") return chunkMarkdown(content, filePath);
  if (ext === ".html") return chunkHtml(content, filePath);
  return chunkCode(content, filePath);
}

// ── VectorIndexer ──────────────────────────────────────

export class VectorIndexer {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Index a single project -- scans all supported file types.
   * Returns the number of chunks indexed.
   */
  async indexProject(projectId: string, projectPath: string): Promise<number> {
    if (!existsSync(projectPath)) {
      log.warn({ projectPath }, "path not found");
      return 0;
    }

    const { files, capped } = await walkDir(projectPath);
    if (capped) {
      log.warn(
        { projectId, projectPath, indexedFiles: files.length, cap: MAX_FILES_PER_PROJECT },
        "project exceeds file cap — indexing a partial set only (not a complete index)",
      );
    }
    let totalChunks = 0;

    // Prepare statements
    const getHash = this.db.prepare(
      `SELECT file_hash FROM vec_file_hashes WHERE project_id = ? AND file_path = ?`
    );
    const upsertHash = this.db.prepare(
      `INSERT OR REPLACE INTO vec_file_hashes (project_id, file_path, file_hash, chunk_count, indexed_at) VALUES (?, ?, ?, ?, datetime('now'))`
    );
    const deleteOldChunks = this.db.prepare(
      `DELETE FROM chunk_metadata WHERE project_id = ? AND file_path = ?`
    );
    const insertMeta = this.db.prepare(
      `INSERT INTO chunk_metadata (id, project_id, file_path, chunk_type, heading, content, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertVec = this.db.prepare(
      `INSERT INTO vec_chunks(embedding) VALUES (?)`
    );

    let scanned = 0;
    for (const filePath of files) {
      // Yield during the read+hash scan so a re-index of many CACHED files
      // (which `continue` below before the embed-time yields) can't block the
      // event loop. WALK_YIELD_EVERY is reused as the scan cadence.
      if (++scanned % WALK_YIELD_EVERY === 0) {
        await new Promise((r) => setImmediate(r));
      }

      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      const hash = fileHash(content);
      const relPath = relative(projectPath, filePath);

      // Skip if unchanged
      const existing = getHash.get(projectId, relPath) as { file_hash: string } | undefined;
      if (existing?.file_hash === hash) continue;

      const ext = extname(filePath).toLowerCase();
      const chunks = chunkFile(content, relPath, ext);
      if (chunks.length === 0) continue;

      // Delete old data for this file (vec first, then metadata)
      // We need to get IDs before deleting metadata
      const oldIds = this.db.prepare(
        `SELECT id FROM chunk_metadata WHERE project_id = ? AND file_path = ?`
      ).all(projectId, relPath) as Array<{ id: number }>;

      if (oldIds.length > 0) {
        const placeholders = oldIds.map(() => "?").join(",");
        this.db.prepare(`DELETE FROM vec_chunks WHERE rowid IN (${placeholders})`).run(...oldIds.map(r => r.id));
        deleteOldChunks.run(projectId, relPath);
      }

      // Cap chunks per file to prevent OOM on huge files
      const cappedChunks = chunks.slice(0, 100);

      // Generate embeddings in small batches (10 at a time) with yields to unblock event loop
      const texts = cappedChunks.map(c => {
        const prefix = c.heading ? `${c.heading}: ` : "";
        return `${prefix}${c.content}`.slice(0, 500);
      });

      let embeddings: Float32Array[];
      try {
        embeddings = [];
        const BATCH = 10;
        for (let b = 0; b < texts.length; b += BATCH) {
          const batch = texts.slice(b, b + BATCH);
          const batchEmbeddings = await embedBatch(batch);
          embeddings.push(...batchEmbeddings);
          // Yield to event loop so HTTP requests can be served
          await new Promise(r => setTimeout(r, 0));
        }
      } catch (err) {
        log.warn({ relPath, err }, "embedding failed");
        continue;
      }

      // Insert in a transaction: vec first (auto rowid), then metadata with matching id
      const insertTransaction = this.db.transaction(() => {
        for (let i = 0; i < cappedChunks.length; i++) {
          const chunk = cappedChunks[i];
          const embBuf = Buffer.from(embeddings[i].buffer, embeddings[i].byteOffset, embeddings[i].byteLength);
          const vecResult = insertVec.run(embBuf);
          const rowId = Number(vecResult.lastInsertRowid);
          insertMeta.run(
            rowId, projectId, chunk.filePath, chunk.chunkType,
            chunk.heading, chunk.content,
            chunk.lineStart, chunk.lineEnd,
          );
        }
        upsertHash.run(projectId, relPath, hash, cappedChunks.length);
      });

      insertTransaction();
      totalChunks += cappedChunks.length;

      // Yield between files
      await new Promise(r => setTimeout(r, 0));
    }

    log.info({ projectId, totalChunks }, "indexed chunks for project");
    return totalChunks;
  }

  /**
   * Index all active projects.
   */
  async indexAllActive(): Promise<number> {
    // Only real filesystem paths — the '__adhoc__/<org>' catch-all projects
    // (auto-provisioned for sessions in unregistered folders) are sentinels,
    // not directories; indexing them just logged "path not found" every pass.
    const projects = this.db.prepare(
      `SELECT id, path FROM projects WHERE active = 1 AND path LIKE '/%'`
    ).all() as Array<{ id: string; path: string }>;

    let total = 0;
    for (const project of projects) {
      total += await this.indexProject(project.id, project.path);
    }
    return total;
  }

  /**
   * Search for chunks similar to a query within a project.
   */
  async search(projectId: string, query: string, limit: number = 5): Promise<SearchResult[]> {
    const queryEmbedding = await embed(query);
    const vecBuffer = Buffer.from(queryEmbedding.buffer);

    const rows = this.db.prepare(`
      SELECT v.rowid, v.distance, m.project_id, m.file_path, m.chunk_type, m.heading, m.content, m.line_start, m.line_end
      FROM vec_chunks v
      JOIN chunk_metadata m ON v.rowid = m.id
      WHERE v.embedding MATCH ? AND k = ?
      AND m.project_id = ?
      ORDER BY v.distance
    `).all(vecBuffer, limit, projectId) as Array<{
      rowid: number;
      distance: number;
      project_id: string;
      file_path: string;
      chunk_type: string;
      heading: string | null;
      content: string;
      line_start: number | null;
      line_end: number | null;
    }>;

    return rows.map(r => ({
      filePath: r.file_path,
      heading: r.heading,
      content: r.content,
      chunkType: r.chunk_type,
      distance: r.distance,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      projectId: r.project_id,
    }));
  }

  /**
   * Search across all projects.
   */
  async searchAll(query: string, limit: number = 10): Promise<SearchResult[]> {
    const queryEmbedding = await embed(query);
    const vecBuffer = Buffer.from(queryEmbedding.buffer);

    const rows = this.db.prepare(`
      SELECT v.rowid, v.distance, m.project_id, m.file_path, m.chunk_type, m.heading, m.content, m.line_start, m.line_end
      FROM vec_chunks v
      JOIN chunk_metadata m ON v.rowid = m.id
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance
    `).all(vecBuffer, limit) as Array<{
      rowid: number;
      distance: number;
      project_id: string;
      file_path: string;
      chunk_type: string;
      heading: string | null;
      content: string;
      line_start: number | null;
      line_end: number | null;
    }>;

    return rows.map(r => ({
      filePath: r.file_path,
      heading: r.heading,
      content: r.content,
      chunkType: r.chunk_type,
      distance: r.distance,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      projectId: r.project_id,
    }));
  }

  /**
   * Find the best plan/doc match for a strategy node.
   */
  async findPlanForNode(
    projectId: string,
    nodeTitle: string,
    nodeDescription?: string,
  ): Promise<SearchResult | null> {
    const query = nodeDescription
      ? `${nodeTitle} ${nodeDescription}`
      : nodeTitle;

    const results = await this.search(projectId, query, 3);

    // Prefer doc/plan type chunks over code
    const docResult = results.find(r => r.chunkType === "doc" || r.chunkType === "html");
    return docResult ?? results[0] ?? null;
  }
}

/**
 * Factory: create a VectorIndexer backed by the given database.
 */
export function createVectorIndexer(db: Database.Database): VectorIndexer {
  return new VectorIndexer(db);
}
