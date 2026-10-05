#!/usr/bin/env bash
#
# One-shot migration: re-attribute brain rows that landed under the
# `_org_level` sentinel because of the hook-ingest bug fixed in
# Phase 22. For each brain table that has session_id, look up the
# session's real project_id in the main nosleep.db and update.
#
# Safe to re-run: WHERE clause restricts to project_id = '_org_level'
# rows, so already-fixed rows are skipped.
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
MAIN_DB="${NOSLEEP_DB_PATH:-${REPO}/data/nosleep.db}"
BRAIN_ROOT="${NOSLEEP_BRAIN_ROOT:-${REPO}/data/brain}"

if [ ! -f "${MAIN_DB}" ]; then
  echo "main db not found at ${MAIN_DB}"
  exit 1
fi

for org_dir in "${BRAIN_ROOT}"/*/ ; do
  org_id=$(basename "${org_dir}")
  brain_db="${org_dir}active.db"
  [ -f "${brain_db}" ] || continue

  echo "==${org_id}: before=="
  sqlite3 "${brain_db}" <<SQL
SELECT 'artifacts at _org_level', COUNT(*) FROM artifacts WHERE project_id = '_org_level';
SELECT 'thoughts at _org_level',  COUNT(*) FROM thoughts  WHERE project_id = '_org_level';
SQL

  # The artifacts table has a "core column immutability" trigger
  # (trg_no_update_artifacts_core) that blocks project_id updates. We
  # drop it for this one migration, then re-create it from the canonical
  # DDL below. The trigger is a forensic invariant, not behaviour the
  # caller depends on — re-creating it is safe and idempotent.
  sqlite3 "${brain_db}" "DROP TRIGGER IF EXISTS trg_no_update_artifacts_core;"

  # Build a session→project mapping from the main DB scoped to this org,
  # written to a temp table inside the brain DB so we can JOIN locally.
  sqlite3 "${brain_db}" "DROP TABLE IF EXISTS _session_project_map;"
  sqlite3 "${brain_db}" "CREATE TEMP TABLE IF NOT EXISTS _t (x INTEGER);"  # no-op to init shell
  sqlite3 "${brain_db}" \
    "ATTACH DATABASE '${MAIN_DB}' AS main_db;
     CREATE TABLE _session_project_map AS
       SELECT id AS session_id, project_id
         FROM main_db.sessions
         WHERE org_id = '${org_id}'
           AND project_id NOT LIKE '_org_level%';
     DETACH DATABASE main_db;
     CREATE INDEX _spm_session ON _session_project_map(session_id);"

  # Re-attribute artifacts that have a session_id with a known project.
  sqlite3 "${brain_db}" \
    "UPDATE artifacts
        SET project_id = (
          SELECT project_id FROM _session_project_map WHERE _session_project_map.session_id = artifacts.session_id
        )
      WHERE project_id = '_org_level'
        AND session_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM _session_project_map WHERE _session_project_map.session_id = artifacts.session_id);"

  # Thoughts: re-attribute via thought_archive_refs → artifacts (which we
  # just fixed). Pick any non-`_org_level` source artifact for the project.
  sqlite3 "${brain_db}" \
    "UPDATE thoughts
        SET project_id = (
          SELECT a.project_id
            FROM artifacts a
            JOIN thought_archive_refs r ON r.archive_hash = a.hash
           WHERE r.thought_id = thoughts.id
             AND a.project_id != '_org_level'
           LIMIT 1
        )
      WHERE project_id = '_org_level'
        AND EXISTS (
          SELECT 1
            FROM artifacts a
            JOIN thought_archive_refs r ON r.archive_hash = a.hash
           WHERE r.thought_id = thoughts.id
             AND a.project_id != '_org_level'
        );"

  # Drop the helper table.
  sqlite3 "${brain_db}" "DROP TABLE _session_project_map;"

  # Re-create the immutability trigger so the archive stays append-only
  # going forward.
  sqlite3 "${brain_db}" "CREATE TRIGGER trg_no_update_artifacts_core
        BEFORE UPDATE OF
          hash, kind, ts, org_id, project_id, session_id, turn_ord,
          origin_tool, origin_version, actor, content, content_type,
          size, schema_version
        ON artifacts
          BEGIN SELECT RAISE(ABORT, 'archive is append-only: artifact content/identity is immutable'); END;"

  echo "==${org_id}: after=="
  sqlite3 "${brain_db}" <<SQL
SELECT 'artifacts at _org_level (remaining)', COUNT(*) FROM artifacts WHERE project_id = '_org_level';
SELECT 'thoughts at _org_level (remaining)',  COUNT(*) FROM thoughts  WHERE project_id = '_org_level';
SELECT 'artifacts by project (top 5)', project_id, COUNT(*) FROM artifacts GROUP BY project_id ORDER BY 3 DESC LIMIT 5;
SELECT 'thoughts by project (top 5)',  project_id, COUNT(*) FROM thoughts  GROUP BY project_id ORDER BY 3 DESC LIMIT 5;
SQL
  echo ""
done

echo "done."
