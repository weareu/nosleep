"""Registry mapping orgs/projects to NotebookLM notebook IDs.

Stores mappings in SQLite with tables:
- research_notebooks: org -> notebook mapping
- research_log: query history for token savings tracking
"""

from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional


@dataclass(frozen=True)
class NotebookRecord:
    id: str
    org_id: str
    project_id: Optional[str]
    notebook_lm_id: str
    title: str
    source_count: int
    last_queried_at: Optional[str]
    created_at: str


@dataclass(frozen=True)
class ResearchLogEntry:
    id: int
    org_id: str
    notebook_id: Optional[str]
    query: str
    response_summary: Optional[str]
    sources_cited: int
    estimated_tokens_saved: int
    created_at: str


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS research_notebooks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT,
  notebook_lm_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  last_queried_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS research_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  notebook_id TEXT REFERENCES research_notebooks(id),
  query TEXT NOT NULL,
  response_summary TEXT,
  sources_cited INTEGER DEFAULT 0,
  estimated_tokens_saved INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_research_notebooks_org ON research_notebooks(org_id);
CREATE INDEX IF NOT EXISTS idx_research_log_org ON research_log(org_id, created_at);
"""


class NotebookRegistry:
    """Manages the mapping between orgs/projects and NotebookLM notebooks."""

    def __init__(self, db_path: Optional[str] = None) -> None:
        resolved_path = db_path or os.environ.get("NOSLEEP_DB_PATH", "./research.db")
        self._db = sqlite3.connect(resolved_path)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode = WAL")
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.executescript(SCHEMA_SQL)

    def close(self) -> None:
        self._db.close()

    def register_notebook(
        self,
        *,
        notebook_id: str,
        org_id: str,
        notebook_lm_id: str,
        title: str,
        project_id: Optional[str] = None,
    ) -> NotebookRecord:
        """Register a new notebook mapping."""
        self._db.execute(
            """INSERT INTO research_notebooks (id, org_id, project_id, notebook_lm_id, title)
               VALUES (?, ?, ?, ?, ?)""",
            (notebook_id, org_id, project_id, notebook_lm_id, title),
        )
        self._db.commit()
        return NotebookRecord(
            id=notebook_id,
            org_id=org_id,
            project_id=project_id,
            notebook_lm_id=notebook_lm_id,
            title=title,
            source_count=0,
            last_queried_at=None,
            created_at=datetime.now(timezone.utc).isoformat(),
        )

    def get_notebook(self, notebook_id: str, org_id: str) -> Optional[NotebookRecord]:
        """Get a notebook by ID, scoped to org."""
        row = self._db.execute(
            "SELECT * FROM research_notebooks WHERE id = ? AND org_id = ?",
            (notebook_id, org_id),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_record(row)

    def get_default_notebook(self, org_id: str) -> Optional[NotebookRecord]:
        """Get the default 'general' notebook for an org."""
        row = self._db.execute(
            "SELECT * FROM research_notebooks WHERE org_id = ? AND title = 'general' LIMIT 1",
            (org_id,),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_record(row)

    def list_notebooks(self, org_id: str) -> list[NotebookRecord]:
        """List all notebooks for an org."""
        rows = self._db.execute(
            "SELECT * FROM research_notebooks WHERE org_id = ? ORDER BY created_at DESC",
            (org_id,),
        ).fetchall()
        return [self._row_to_record(r) for r in rows]

    def update_source_count(self, notebook_id: str, count: int) -> None:
        """Update the source count for a notebook."""
        self._db.execute(
            "UPDATE research_notebooks SET source_count = ? WHERE id = ?",
            (count, notebook_id),
        )
        self._db.commit()

    def mark_queried(self, notebook_id: str) -> None:
        """Update the last_queried_at timestamp."""
        self._db.execute(
            "UPDATE research_notebooks SET last_queried_at = datetime('now') WHERE id = ?",
            (notebook_id,),
        )
        self._db.commit()

    def log_query(
        self,
        *,
        org_id: str,
        notebook_id: Optional[str],
        query: str,
        response_summary: Optional[str] = None,
        sources_cited: int = 0,
        estimated_tokens_saved: int = 0,
    ) -> None:
        """Log a research query for token savings tracking."""
        self._db.execute(
            """INSERT INTO research_log
               (org_id, notebook_id, query, response_summary, sources_cited, estimated_tokens_saved)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (org_id, notebook_id, query, response_summary, sources_cited, estimated_tokens_saved),
        )
        self._db.commit()

    def get_recent_logs(
        self, org_id: str, limit: int = 50
    ) -> list[ResearchLogEntry]:
        """Get recent research log entries for an org."""
        rows = self._db.execute(
            """SELECT * FROM research_log
               WHERE org_id = ?
               ORDER BY created_at DESC
               LIMIT ?""",
            (org_id, limit),
        ).fetchall()
        return [
            ResearchLogEntry(
                id=r["id"],
                org_id=r["org_id"],
                notebook_id=r["notebook_id"],
                query=r["query"],
                response_summary=r["response_summary"],
                sources_cited=r["sources_cited"],
                estimated_tokens_saved=r["estimated_tokens_saved"],
                created_at=r["created_at"],
            )
            for r in rows
        ]

    def get_total_tokens_saved(self, org_id: str) -> int:
        """Get total estimated tokens saved for an org."""
        row = self._db.execute(
            "SELECT COALESCE(SUM(estimated_tokens_saved), 0) as total FROM research_log WHERE org_id = ?",
            (org_id,),
        ).fetchone()
        return int(row["total"]) if row else 0

    @staticmethod
    def _row_to_record(row: sqlite3.Row) -> NotebookRecord:
        return NotebookRecord(
            id=row["id"],
            org_id=row["org_id"],
            project_id=row["project_id"],
            notebook_lm_id=row["notebook_lm_id"],
            title=row["title"],
            source_count=row["source_count"],
            last_queried_at=row["last_queried_at"],
            created_at=row["created_at"],
        )
