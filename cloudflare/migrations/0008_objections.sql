-- Phase 1 / ADR-005, ADR-009, ADR-014, ADR-020.
-- Keep complete provider text; structured objections and human corrections are additional records.
CREATE TABLE ai_output_metadata (
  ai_output_id TEXT PRIMARY KEY REFERENCES ai_outputs(id) ON DELETE RESTRICT,
  provider_model_id TEXT,
  prompt_version TEXT,
  prompt_sha256 TEXT,
  input_sha256 TEXT,
  finish_reason TEXT,
  token_usage_json TEXT CHECK(token_usage_json IS NULL OR json_valid(token_usage_json)),
  captured_at TEXT NOT NULL
);
CREATE TABLE critique_parse_status (
  ai_output_id TEXT PRIMARY KEY REFERENCES ai_outputs(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('valid','needs_human','resolved')),
  error_code TEXT,
  checked_at TEXT NOT NULL
);
CREATE TABLE review_objections (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES task_rounds(id) ON DELETE RESTRICT,
  source_critique_output_id TEXT REFERENCES ai_outputs(id) ON DELETE RESTRICT,
  target_output_id TEXT NOT NULL REFERENCES ai_outputs(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK(origin IN ('ai','human')),
  anchor_kind TEXT NOT NULL CHECK(anchor_kind IN ('sentence','paragraph','whole')),
  quoted_text TEXT NOT NULL DEFAULT '',
  start_offset INTEGER,
  end_offset INTEGER,
  objection_text TEXT NOT NULL CHECK(length(objection_text) BETWEEN 1 AND 50000),
  created_at TEXT NOT NULL,
  CHECK(origin <> 'ai' OR source_critique_output_id IS NOT NULL),
  CHECK(
    (anchor_kind='whole' AND start_offset IS NULL AND end_offset IS NULL)
    OR
    (anchor_kind IN ('sentence','paragraph') AND length(quoted_text)>0
      AND start_offset IS NOT NULL AND end_offset IS NOT NULL
      AND start_offset>=0 AND end_offset>start_offset)
  )
);
CREATE INDEX idx_objections_round ON review_objections(round_id,created_at);
CREATE TABLE objection_events (
  id TEXT PRIMARY KEY,
  objection_id TEXT NOT NULL REFERENCES review_objections(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN
    ('create','correct','merge','split','annotate','resolve')),
  actor TEXT NOT NULL CHECK(actor IN ('human','system')),
  prior_revision INTEGER NOT NULL CHECK(prior_revision>=0),
  next_revision INTEGER NOT NULL CHECK(next_revision=prior_revision+1),
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  created_at TEXT NOT NULL,
  UNIQUE(objection_id,next_revision)
);
CREATE TABLE objection_relations (
  parent_objection_id TEXT NOT NULL REFERENCES review_objections(id) ON DELETE RESTRICT,
  child_objection_id TEXT NOT NULL REFERENCES review_objections(id) ON DELETE RESTRICT,
  relation TEXT NOT NULL CHECK(relation IN ('merge','split','derived')),
  PRIMARY KEY(parent_objection_id,child_objection_id,relation),
  CHECK(parent_objection_id<>child_objection_id)
);

-- Existing AI outputs had no immutability trigger: preserve raw provider evidence.
CREATE TRIGGER prevent_ai_output_rewrite BEFORE UPDATE ON ai_outputs
BEGIN SELECT RAISE(ABORT,'AI_OUTPUT_IMMUTABLE'); END;
CREATE TRIGGER prevent_ai_output_delete BEFORE DELETE ON ai_outputs
BEGIN SELECT RAISE(ABORT,'AI_OUTPUT_IMMUTABLE'); END;
CREATE TRIGGER prevent_objection_rewrite BEFORE UPDATE ON review_objections
BEGIN SELECT RAISE(ABORT,'OBJECTION_ORIGINAL_IMMUTABLE'); END;
CREATE TRIGGER prevent_objection_delete BEFORE DELETE ON review_objections
BEGIN SELECT RAISE(ABORT,'OBJECTION_ORIGINAL_IMMUTABLE'); END;
CREATE TRIGGER prevent_objection_event_update BEFORE UPDATE ON objection_events
BEGIN SELECT RAISE(ABORT,'OBJECTION_EVENT_IMMUTABLE'); END;
CREATE TRIGGER prevent_objection_event_delete BEFORE DELETE ON objection_events
BEGIN SELECT RAISE(ABORT,'OBJECTION_EVENT_IMMUTABLE'); END;
CREATE TRIGGER prevent_objection_relation_delete BEFORE DELETE ON objection_relations
BEGIN SELECT RAISE(ABORT,'OBJECTION_RELATION_IMMUTABLE'); END;

-- A critique and the output it objects to must be in the same review round.
CREATE TRIGGER ensure_objection_outputs_same_round
BEFORE INSERT ON review_objections
WHEN NOT EXISTS(SELECT 1 FROM ai_outputs a
                WHERE a.id=NEW.target_output_id AND a.round_id=NEW.round_id)
  OR (NEW.source_critique_output_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM ai_outputs a WHERE a.id=NEW.source_critique_output_id
        AND a.round_id=NEW.round_id AND a.phase='critique'))
BEGIN SELECT RAISE(ABORT,'OBJECTION_CROSS_ROUND'); END;
CREATE TRIGGER ensure_parse_status_is_critique
BEFORE INSERT ON critique_parse_status
WHEN NOT EXISTS (SELECT 1 FROM ai_outputs a
                 WHERE a.id=NEW.ai_output_id AND a.phase='critique')
BEGIN SELECT RAISE(ABORT,'NOT_CRITIQUE_OUTPUT'); END;
CREATE TRIGGER ensure_relation_same_round
BEFORE INSERT ON objection_relations
WHEN NOT EXISTS (
  SELECT 1 FROM review_objections a JOIN review_objections b
  ON a.round_id=b.round_id
  WHERE a.id=NEW.parent_objection_id AND b.id=NEW.child_objection_id
)
BEGIN SELECT RAISE(ABORT,'OBJECTION_RELATION_CROSS_ROUND'); END;
