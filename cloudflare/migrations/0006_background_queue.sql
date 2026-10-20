-- One active Cloudflare Queue review request per task.
-- Existing tasks remain idle (0); this migration NEVER starts model requests.
ALTER TABLE tasks ADD COLUMN queue_requested INTEGER NOT NULL DEFAULT 0
  CHECK(queue_requested IN (0,1));
CREATE INDEX IF NOT EXISTS idx_tasks_queue_requested ON tasks(queue_requested,status);
