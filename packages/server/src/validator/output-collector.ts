import { execFileSync } from "node:child_process";

interface FileChange {
  readonly file: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
}

interface ChangeCollection {
  readonly modifiedFiles: readonly string[];
  readonly additions: number;
  readonly deletions: number;
  readonly diffSummary: string;
  readonly fileChanges: readonly FileChange[];
}

/**
 * Collects files modified during a session via git diff.
 */
export class OutputCollector {
  /**
   * Collect all changes in a project directory since a given start time.
   */
  collectChanges(projectPath: string, sessionStartTime: string): ChangeCollection {
    try {
      // Find the commit closest to session start
      const baseCommit = this.findBaseCommit(projectPath, sessionStartTime);

      if (!baseCommit) {
        // No commits before session start; diff against working tree
        return this.collectFromWorkingTree(projectPath);
      }

      // Get diff stat from base commit to HEAD
      const diffStat = this.runGit(
        projectPath,
        ["diff", "--stat", baseCommit, "HEAD"],
      );

      // Get numstat for additions/deletions
      const numstat = this.runGit(
        projectPath,
        ["diff", "--numstat", baseCommit, "HEAD"],
      );

      const { additions, deletions } = this.parseNumstat(numstat);

      // Get name-status for file change types
      const nameStatus = this.runGit(
        projectPath,
        ["diff", "--name-status", baseCommit, "HEAD"],
      );

      const fileChanges = this.parseNameStatus(nameStatus);
      const modifiedFiles = fileChanges.map((fc) => fc.file);

      // Also include uncommitted changes
      const uncommittedFiles = this.getUncommittedFiles(projectPath);
      const allModified = [...new Set([...modifiedFiles, ...uncommittedFiles])];

      return {
        modifiedFiles: allModified,
        additions,
        deletions,
        diffSummary: diffStat || "No committed changes",
        fileChanges,
      };
    } catch {
      // Not a git repo or git not available
      return {
        modifiedFiles: [],
        additions: 0,
        deletions: 0,
        diffSummary: "Unable to collect git changes",
        fileChanges: [],
      };
    }
  }

  // ── Internal ──────────────────────────────────────────

  private findBaseCommit(projectPath: string, sinceTime: string): string | null {
    try {
      const result = this.runGit(
        projectPath,
        ["log", `--before=${sinceTime}`, "--format=%H", "-1"],
      );
      return result.trim() || null;
    } catch {
      return null;
    }
  }

  private collectFromWorkingTree(projectPath: string): ChangeCollection {
    try {
      const diffStat = this.runGit(projectPath, ["diff", "--stat"]);
      const numstat = this.runGit(projectPath, ["diff", "--numstat"]);
      const { additions, deletions } = this.parseNumstat(numstat);
      const uncommitted = this.getUncommittedFiles(projectPath);

      return {
        modifiedFiles: uncommitted,
        additions,
        deletions,
        diffSummary: diffStat || "Working tree changes only",
        fileChanges: uncommitted.map((f) => ({ file: f, status: "modified" as const })),
      };
    } catch {
      return {
        modifiedFiles: [],
        additions: 0,
        deletions: 0,
        diffSummary: "Unable to collect changes",
        fileChanges: [],
      };
    }
  }

  private getUncommittedFiles(projectPath: string): readonly string[] {
    try {
      const result = this.runGit(projectPath, ["diff", "--name-only", "HEAD"]);
      const staged = this.runGit(projectPath, ["diff", "--name-only", "--cached"]);
      const files = [...result.split("\n"), ...staged.split("\n")]
        .map((f) => f.trim())
        .filter((f) => f.length > 0);
      return [...new Set(files)];
    } catch {
      return [];
    }
  }

  private parseNumstat(numstat: string): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;

    for (const line of numstat.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const add = parseInt(parts[0], 10);
        const del = parseInt(parts[1], 10);
        if (!isNaN(add)) additions += add;
        if (!isNaN(del)) deletions += del;
      }
    }

    return { additions, deletions };
  }

  private parseNameStatus(nameStatus: string): readonly FileChange[] {
    const changes: FileChange[] = [];

    for (const line of nameStatus.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const statusChar = trimmed[0];
      const file = trimmed.slice(1).trim().split("\t").pop()?.trim() ?? "";
      if (!file) continue;

      const statusMap: Record<string, FileChange["status"]> = {
        A: "added",
        M: "modified",
        D: "deleted",
        R: "renamed",
      };

      changes.push({
        file,
        status: statusMap[statusChar] ?? "modified",
      });
    }

    return changes;
  }

  private runGit(cwd: string, args: readonly string[]): string {
    return execFileSync("git", args as string[], {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
}
