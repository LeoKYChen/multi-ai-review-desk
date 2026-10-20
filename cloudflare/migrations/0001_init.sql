-- Multi-AI individual desk: D1-only schema. Plain text; never save .docx bytes.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 180),
 instruction TEXT NOT NULL CHECK(length(instruction) <= 20000),
 document_text TEXT NOT NULL DEFAULT '' CHECK(length(document_text) <= 50000),
 document_name TEXT,
 status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','running','awaiting_human','needs_rework','closed','failed')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_rounds (
 id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
 state TEXT NOT NULL CHECK(state IN ('running','awaiting_human','failed','closed','needs_rework')),
 created_at TEXT NOT NULL,
 UNIQUE(task_id,ordinal)
);
CREATE TABLE IF NOT EXISTS ai_outputs (
 id TEXT PRIMARY KEY,
 round_id TEXT NOT NULL REFERENCES task_rounds(id) ON DELETE CASCADE,
 provider TEXT NOT NULL CHECK(provider IN ('chatgpt','gemini')),
 phase TEXT NOT NULL CHECK(phase IN ('independent','critique','proposal')),
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 50000),
 created_at TEXT NOT NULL,
 UNIQUE(round_id,provider,phase)
);
CREATE TABLE IF NOT EXISTS human_decisions (
 id TEXT PRIMARY KEY,
 round_id TEXT NOT NULL UNIQUE REFERENCES task_rounds(id) ON DELETE CASCADE,
 decision TEXT NOT NULL CHECK(decision IN ('accept_chatgpt','accept_gemini','partial','reject','rework')),
 note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 10000),
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rounds_task ON task_rounds(task_id,ordinal DESC);
CREATE INDEX IF NOT EXISTS idx_outputs_round ON ai_outputs(round_id,phase,provider);
CREATE TRIGGER IF NOT EXISTS prevent_source_rewrite
BEFORE UPDATE OF instruction,document_text,document_name,title ON tasks
BEGIN SELECT RAISE(ABORT,'ORIGINAL_SOURCE_IMMUTABLE'); END;
