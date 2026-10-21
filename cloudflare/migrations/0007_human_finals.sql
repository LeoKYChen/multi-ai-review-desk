-- Phase 1 / ADR-002, ADR-004, ADR-006, ADR-010, ADR-013, ADR-018.
-- Additive-only: preserve the original task, round, model outputs and human decisions.
ALTER TABLE tasks ADD COLUMN template_key TEXT NOT NULL DEFAULT 'general'
  CHECK(template_key IN ('general','exam_essay'));

CREATE TABLE final_versions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK(version_no > 0),
  parent_version_id TEXT REFERENCES final_versions(id) ON DELETE RESTRICT,
  review_round_id TEXT REFERENCES task_rounds(id) ON DELETE RESTRICT,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 100000),
  decision TEXT NOT NULL CHECK(decision IN
    ('accept_chatgpt','accept_gemini','partial','reject','manual_revision')),
  note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 10000),
  source_snapshot_json TEXT NOT NULL CHECK(json_valid(source_snapshot_json)
    AND json_type(source_snapshot_json) = 'array'),
  approved_at TEXT NOT NULL,
  UNIQUE(task_id,version_no),
  CHECK(parent_version_id IS NULL OR parent_version_id <> id)
);
CREATE INDEX idx_final_versions_task ON final_versions(task_id,version_no DESC);

CREATE TABLE human_drafts (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
  base_final_id TEXT REFERENCES final_versions(id) ON DELETE RESTRICT,
  body TEXT NOT NULL DEFAULT '' CHECK(length(body) <= 100000),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at TEXT NOT NULL
);

-- No approved text or verification snapshot can ever be updated or deleted.
CREATE TRIGGER prevent_final_version_update
BEFORE UPDATE ON final_versions
BEGIN SELECT RAISE(ABORT,'FINAL_VERSION_IMMUTABLE'); END;
CREATE TRIGGER prevent_final_version_delete
BEFORE DELETE ON final_versions
BEGIN SELECT RAISE(ABORT,'FINAL_VERSION_IMMUTABLE'); END;
CREATE TRIGGER prevent_task_with_final_delete
BEFORE DELETE ON tasks
WHEN EXISTS(SELECT 1 FROM final_versions WHERE task_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'TASK_WITH_FINAL_IMMUTABLE'); END;

-- A final's parent and review round must belong to the same task.
CREATE TRIGGER ensure_final_lineage_insert
BEFORE INSERT ON final_versions
WHEN (NEW.parent_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM final_versions p
    WHERE p.id=NEW.parent_version_id AND p.task_id=NEW.task_id
      AND p.version_no < NEW.version_no
  ))
  OR (NEW.review_round_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM task_rounds r WHERE r.id=NEW.review_round_id AND r.task_id=NEW.task_id
  ))
  OR (NEW.version_no=1 AND NEW.parent_version_id IS NOT NULL)
  OR (NEW.version_no>1 AND NEW.parent_version_id IS NULL)
BEGIN SELECT RAISE(ABORT,'FINAL_VERSION_CROSS_TASK_OR_LINEAGE'); END;

CREATE TRIGGER ensure_draft_parent_insert
BEFORE INSERT ON human_drafts
WHEN NEW.base_final_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM final_versions f WHERE f.id=NEW.base_final_id AND f.task_id=NEW.task_id
)
BEGIN SELECT RAISE(ABORT,'DRAFT_BASE_CROSS_TASK'); END;
CREATE TRIGGER ensure_draft_parent_update
BEFORE UPDATE OF base_final_id ON human_drafts
WHEN NEW.base_final_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM final_versions f WHERE f.id=NEW.base_final_id AND f.task_id=NEW.task_id
)
BEGIN SELECT RAISE(ABORT,'DRAFT_BASE_CROSS_TASK'); END;
