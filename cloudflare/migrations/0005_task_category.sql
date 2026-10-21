-- Optional classification for v0.8 task management parity.
ALTER TABLE tasks ADD COLUMN category TEXT NOT NULL DEFAULT '一般'
  CHECK(length(category) BETWEEN 1 AND 30);
CREATE INDEX IF NOT EXISTS idx_tasks_category_updated ON tasks(category, updated_at DESC);
