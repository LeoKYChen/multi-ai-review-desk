-- Phase 1 / ADR-008, ADR-012, ADR-018: current checks vs immutable approval snapshot.
CREATE TABLE source_checks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  related_ai_output_id TEXT REFERENCES ai_outputs(id) ON DELETE RESTRICT,
  related_objection_id TEXT REFERENCES review_objections(id) ON DELETE RESTRICT,
  claim_text TEXT NOT NULL CHECK(length(claim_text) BETWEEN 1 AND 50000),
  source_label TEXT NOT NULL DEFAULT '',
  source_uri TEXT,
  source_locator TEXT,
  status TEXT NOT NULL CHECK(status IN ('verified','pending','model_inference')),
  verified_by TEXT CHECK(verified_by IS NULL OR verified_by='human'),
  verified_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  updated_at TEXT NOT NULL,
  CHECK(status <> 'verified' OR
    (verified_by='human' AND verified_at IS NOT NULL))
);
CREATE INDEX idx_source_checks_task_status ON source_checks(task_id,status);
CREATE TABLE source_check_events (
  id TEXT PRIMARY KEY,
  source_check_id TEXT NOT NULL REFERENCES source_checks(id) ON DELETE RESTRICT,
  previous_status TEXT CHECK(previous_status IS NULL OR
    previous_status IN ('verified','pending','model_inference')),
  new_status TEXT NOT NULL CHECK(new_status IN ('verified','pending','model_inference')),
  actor TEXT NOT NULL CHECK(actor IN ('human','system')),
  evidence_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_source_events_check ON source_check_events(source_check_id,created_at);

CREATE TRIGGER ensure_source_reference_task
BEFORE INSERT ON source_checks
WHEN (NEW.related_ai_output_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ai_outputs a JOIN task_rounds r ON a.round_id=r.id
  WHERE a.id=NEW.related_ai_output_id AND r.task_id=NEW.task_id))
 OR (NEW.related_objection_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM review_objections o JOIN task_rounds r ON o.round_id=r.id
  WHERE o.id=NEW.related_objection_id AND r.task_id=NEW.task_id))
BEGIN SELECT RAISE(ABORT,'SOURCE_REFERENCE_CROSS_TASK'); END;
CREATE TRIGGER ensure_source_reference_task_update
BEFORE UPDATE OF related_ai_output_id,related_objection_id,task_id ON source_checks
WHEN (NEW.related_ai_output_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ai_outputs a JOIN task_rounds r ON a.round_id=r.id
  WHERE a.id=NEW.related_ai_output_id AND r.task_id=NEW.task_id))
 OR (NEW.related_objection_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM review_objections o JOIN task_rounds r ON o.round_id=r.id
  WHERE o.id=NEW.related_objection_id AND r.task_id=NEW.task_id))
BEGIN SELECT RAISE(ABORT,'SOURCE_REFERENCE_CROSS_TASK'); END;
CREATE TRIGGER prevent_source_check_event_update BEFORE UPDATE ON source_check_events
BEGIN SELECT RAISE(ABORT,'SOURCE_CHECK_EVENT_IMMUTABLE'); END;
CREATE TRIGGER prevent_source_check_event_delete BEFORE DELETE ON source_check_events
BEGIN SELECT RAISE(ABORT,'SOURCE_CHECK_EVENT_IMMUTABLE'); END;
