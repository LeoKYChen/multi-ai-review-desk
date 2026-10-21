-- Prevent concurrent model calls and duplicate paid requests for the same task.
ALTER TABLE tasks ADD COLUMN run_lock_until INTEGER NOT NULL DEFAULT 0;
