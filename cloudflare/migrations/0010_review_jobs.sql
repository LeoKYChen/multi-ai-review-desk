-- Phase 1 / ADR-007, ADR-011, ADR-016: evidence of a model response != D1 persistence.
-- These tables are inert. They do not enqueue work, invoke providers or change API flags.
CREATE TABLE review_jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  round_id TEXT NOT NULL UNIQUE REFERENCES task_rounds(id) ON DELETE RESTRICT,
  phase TEXT NOT NULL CHECK(phase IN ('independent','critique','proposal')),
  state TEXT NOT NULL CHECK(state IN
    ('queued','running','paused_failure','paused_parse','awaiting_human','completed')),
  lease_until INTEGER NOT NULL DEFAULT 0 CHECK(lease_until>=0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  reason_code TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_review_jobs_state ON review_jobs(state,updated_at);

CREATE TABLE review_model_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES review_jobs(id) ON DELETE RESTRICT,
  round_id TEXT NOT NULL REFERENCES task_rounds(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK(provider IN ('chatgpt','gemini')),
  phase TEXT NOT NULL CHECK(phase IN ('independent','critique','proposal')),
  attempt_no INTEGER NOT NULL CHECK(attempt_no>0),
  state TEXT NOT NULL CHECK(state IN (
    'reserved','request_started','response_received','persisted',
    'definite_pre_dispatch_failure','outcome_unknown')),
  provider_request_id TEXT,
  ai_output_id TEXT UNIQUE REFERENCES ai_outputs(id) ON DELETE RESTRICT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(round_id,provider,phase,attempt_no),
  CHECK(state <> 'persisted' OR ai_output_id IS NOT NULL),
  CHECK(ai_output_id IS NULL OR state='persisted')
);
CREATE INDEX idx_review_model_attempts_round ON review_model_attempts(round_id,provider,phase);

CREATE TABLE retry_authorizations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES review_jobs(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK(provider IN ('chatgpt','gemini')),
  phase TEXT NOT NULL CHECK(phase IN ('independent','critique','proposal')),
  risk_ack INTEGER NOT NULL CHECK(risk_ack=1),
  reason TEXT NOT NULL CHECK(length(reason)>0),
  idempotency_key TEXT NOT NULL UNIQUE,
  granted_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE queue_outbox (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES review_jobs(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('start','continue','resume')),
  state TEXT NOT NULL CHECK(state IN ('pending','sent','processed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_queue_outbox_pending ON queue_outbox(state,created_at);

CREATE TABLE mutation_idempotency (
  scope TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(scope,request_key)
);

-- Keep each job bound to the same task as its round.
CREATE TRIGGER ensure_job_round_matches_task
BEFORE INSERT ON review_jobs
WHEN NOT EXISTS(SELECT 1 FROM task_rounds r
                WHERE r.id=NEW.round_id AND r.task_id=NEW.task_id)
BEGIN SELECT RAISE(ABORT,'JOB_CROSS_TASK'); END;

-- A model attempt can only use the provider/phase recorded in the output,
-- and job/round must agree. The actual paid-call authorization belongs in Phase 2.
CREATE TRIGGER ensure_model_attempt_links
BEFORE INSERT ON review_model_attempts
WHEN NOT EXISTS (SELECT 1 FROM review_jobs j
                 WHERE j.id=NEW.job_id AND j.round_id=NEW.round_id)
 OR (NEW.ai_output_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM ai_outputs a WHERE a.id=NEW.ai_output_id
   AND a.round_id=NEW.round_id AND a.provider=NEW.provider AND a.phase=NEW.phase))
BEGIN SELECT RAISE(ABORT,'MODEL_ATTEMPT_LINK_MISMATCH'); END;
CREATE TRIGGER ensure_model_attempt_update_links
BEFORE UPDATE OF job_id,round_id,provider,phase,ai_output_id ON review_model_attempts
WHEN NOT EXISTS (SELECT 1 FROM review_jobs j
                 WHERE j.id=NEW.job_id AND j.round_id=NEW.round_id)
 OR (NEW.ai_output_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM ai_outputs a WHERE a.id=NEW.ai_output_id
   AND a.round_id=NEW.round_id AND a.provider=NEW.provider AND a.phase=NEW.phase))
BEGIN SELECT RAISE(ABORT,'MODEL_ATTEMPT_LINK_MISMATCH'); END;
CREATE TRIGGER prevent_persisted_model_attempt_regression
BEFORE UPDATE ON review_model_attempts
WHEN OLD.state='persisted' AND (NEW.state<>'persisted'
 OR NEW.ai_output_id<>OLD.ai_output_id)
BEGIN SELECT RAISE(ABORT,'MODEL_OUTPUT_ALREADY_PERSISTED'); END;
