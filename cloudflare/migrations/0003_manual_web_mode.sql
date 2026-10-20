-- Distinguish browser-assisted reports from verified model API output.
ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'api' CHECK(mode IN ('api','manual'));
ALTER TABLE ai_outputs ADD COLUMN source TEXT NOT NULL DEFAULT 'api' CHECK(source IN ('api','manual_unverified'));
