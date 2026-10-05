import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

const PLAN_DIRS = ["docs/plans", "docs/architecture", "docs"];

/**
 * Indexes markdown plan files into FTS5 for fast semantic-ish matching
 * against strategy tree node titles. Splits by ## headings.
 */
export class PlanIndexer {
  constructor(private readonly db: Database.Database) {}

  /**
   * Index all plan files for a project. Skips files that haven't changed (by hash).
   */
  indexProject(projectId: string, projectPath: string): number {
    let indexed = 0;

    for (const relDir of PLAN_DIRS) {
      const dir = join(projectPath, relDir);
      if (!existsSync(dir)) continue;

      let files: string[];
      try { files = readdirSync(dir).filter(f => f.endsWith(".md")); } catch { continue; }

      for (const file of files) {
        const fullPath = join(dir, file);
        try {
          const stat = statSync(fullPath);
          if (!stat.isFile()) continue;

          const content = readFileSync(fullPath, "utf-8");
          const hash = createHash("md5").update(content).digest("hex");

          // Check if already indexed with same hash
          const existing = this.db.prepare(
            `SELECT file_hash FROM plan_files WHERE project_id = ? AND file_path = ?`
          ).get(projectId, fullPath) as { file_hash: string } | undefined;

          if (existing?.file_hash === hash) continue;

          // Re-index this file
          this.db.prepare(`DELETE FROM plan_index WHERE project_id = ? AND file_path = ?`)
            .run(projectId, fullPath);

          this.indexFile(projectId, fullPath, content);

          // Update metadata
          this.db.prepare(`
            INSERT INTO plan_files (project_id, file_path, file_hash, indexed_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(project_id, file_path) DO UPDATE SET file_hash = ?, indexed_at = datetime('now')
          `).run(projectId, fullPath, hash, hash);

          indexed++;
        } catch { continue; }
      }
    }

    return indexed;
  }

  /**
   * Parse a markdown file into heading+content chunks and insert into FTS5.
   */
  private indexFile(projectId: string, filePath: string, content: string): void {
    const lines = content.split("\n");
    let currentHeading = "";
    let currentContent: string[] = [];
    let headingLine = 0;

    const flush = () => {
      if (!currentHeading && currentContent.length === 0) return;
      const heading = currentHeading || "(preamble)";
      const text = currentContent.join(" ").trim().slice(0, 2000);
      if (text.length > 10) { // Skip trivially short sections
        this.db.prepare(
          `INSERT INTO plan_index (project_id, file_path, line_number, heading, content) VALUES (?, ?, ?, ?, ?)`
        ).run(projectId, filePath, headingLine, heading, text);
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^#{1,3}\s+(.+)/);
      if (headingMatch) {
        flush();
        currentHeading = headingMatch[1].trim();
        currentContent = [];
        headingLine = i + 1;
      } else if (line.trim() && !line.startsWith("```") && !line.startsWith("|")) {
        currentContent.push(line.trim());
      }
    }
    flush();
  }

  /**
   * Search for a plan section that matches a strategy node's title/description.
   * Returns the best matching file path and heading, or null.
   */
  findPlanForNode(projectId: string, title: string, description?: string): {
    filePath: string;
    heading: string;
    lineNumber: number;
    snippet: string;
  } | null {
    // Build search query from title + description keywords
    const searchTerms = `${title} ${description ?? ""}`
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 3)
      .slice(0, 10)
      .join(" ");

    if (!searchTerms) return null;

    const row = this.db.prepare(`
      SELECT file_path, heading, line_number, snippet(plan_index, 4, '>>>', '<<<', '...', 30) as snippet,
        rank
      FROM plan_index
      WHERE project_id = ? AND plan_index MATCH ?
      ORDER BY rank
      LIMIT 1
    `).get(projectId, searchTerms) as {
      file_path: string;
      heading: string;
      line_number: number;
      snippet: string;
      rank: number;
    } | undefined;

    return row
      ? { filePath: row.file_path, heading: row.heading, lineNumber: row.line_number, snippet: row.snippet }
      : null;
  }

  /**
   * Index all active projects.
   */
  indexAllActive(): number {
    const projects = this.db.prepare(
      `SELECT id, path FROM projects WHERE active = 1`
    ).all() as Array<{ id: string; path: string }>;

    let total = 0;
    for (const p of projects) {
      total += this.indexProject(p.id, p.path);
    }
    return total;
  }
}
