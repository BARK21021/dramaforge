-- app1-compatible task lifecycle fields used by SSE and /api/tasks recovery.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stage TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "stageProgress" REAL NOT NULL DEFAULT 0;
