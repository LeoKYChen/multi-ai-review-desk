-- Security and API cost guardrails. No original .docx binary is stored.
CREATE TABLE IF NOT EXISTS login_rate_limits (
  visitor_hash TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS model_call_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  round_id TEXT NOT NULL REFERENCES task_rounds(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('chatgpt','gemini')),
  phase TEXT NOT NULL CHECK (phase IN ('independent','critique','proposal')),
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','succeeded','failed'))
);
CREATE INDEX IF NOT EXISTS idx_model_attempts_task ON model_call_attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_model_attempts_requested ON model_call_attempts(requested_at);
