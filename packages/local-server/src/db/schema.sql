-- DramaForge Local Server — SQLite Schema
-- Mirrors the PostgreSQL schema with SQLite-compatible types.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  "avatarUrl" TEXT,
  "passwordHash" TEXT,
  role TEXT NOT NULL DEFAULT 'ADMIN',
  credits INTEGER NOT NULL DEFAULT 999999,
  provider TEXT NOT NULL DEFAULT 'CREDENTIALS',
  "providerId" TEXT,
  "maxConcurrent" INTEGER NOT NULL DEFAULT 3,
  phone TEXT,
  "activeSessionStamp" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "lastLoginAt" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_preferences (
  id TEXT PRIMARY KEY,
  "userId" TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  locale TEXT NOT NULL DEFAULT 'zh',
  theme TEXT NOT NULL DEFAULT 'dark',
  "uiPrefs" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt" TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_configs (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  "apiKey" TEXT NOT NULL,
  "baseUrl" TEXT,
  "isEnabled" INTEGER NOT NULL DEFAULT 1,
  label TEXT,
  weight INTEGER NOT NULL DEFAULT 1,
  "keyStatus" TEXT NOT NULL DEFAULT 'active',
  "lastUsedAt" TEXT,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "disabledUntil" TEXT,
  "lastErrorMessage" TEXT,
  "maxConcurrent" INTEGER NOT NULL DEFAULT 3,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt" TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_configs_user ON api_configs("userId");

CREATE TABLE IF NOT EXISTS seedance_presets (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt" TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE("userId", name)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  "scriptData" TEXT,
  "artStyle" TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  category TEXT NOT NULL DEFAULT 'DOMESTIC',
  "sourceProjectId" TEXT REFERENCES projects(id) ON DELETE SET NULL,
  "scriptOverride" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt" TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects("userId");
CREATE INDEX IF NOT EXISTS idx_projects_category ON projects(category);
CREATE INDEX IF NOT EXISTS idx_projects_source ON projects("sourceProjectId");

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  "scriptData" TEXT,
  "episodeNumber" INTEGER,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt" TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_episodes_project ON episodes("projectId");

CREATE TABLE IF NOT EXISTS storyboards (
  id TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode TEXT NOT NULL,
  "shotIndex" INTEGER NOT NULL,
  "shotType" TEXT,
  description TEXT,
  dialogue TEXT,
  duration REAL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt" TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE("projectId", episode, "shotIndex")
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  "imageUrl" TEXT,
  "pencilImageUrl" TEXT,
  "pencilPaintEnabled" INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt" TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets("projectId");

CREATE TABLE IF NOT EXISTS asset_image_revisions (
  id TEXT PRIMARY KEY,
  "assetId" TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  "imageUrl" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  params TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "activatedAt" TEXT
);
CREATE INDEX IF NOT EXISTS idx_asset_revisions_asset ON asset_image_revisions("assetId");

CREATE TABLE IF NOT EXISTS shots (
  id TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  "episodeId" TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  "sceneId" TEXT,
  "shotIndex" INTEGER NOT NULL,
  "shotSeq" TEXT,
  "durationSeconds" REAL,
  "visualPrompt" TEXT,
  "stylePrompt" TEXT,
  "aspectRatio" TEXT DEFAULT '9:16',
  resolution TEXT,
  "purposeTag" TEXT,
  "emotionArcPosition" TEXT,
  "montageType" TEXT,
  "audioType" TEXT,
  "referencedAssets" TEXT,
  "currentMaterialId" TEXT,
  "currentMaterialUrl" TEXT,
  "videoStatus" TEXT DEFAULT 'PENDING',
  status TEXT DEFAULT 'PENDING',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt" TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE("projectId", "episodeId", "shotIndex")
);
CREATE INDEX IF NOT EXISTS idx_shots_project ON shots("projectId");
CREATE INDEX IF NOT EXISTS idx_shots_episode ON shots("episodeId");

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  "shotId" TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  "projectId" TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  "materialType" TEXT NOT NULL,
  "materialUrl" TEXT NOT NULL,
  "modelProvider" TEXT,
  "modelName" TEXT,
  params TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_materials_shot ON materials("shotId");

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "projectId" TEXT REFERENCES projects(id) ON DELETE CASCADE,
  "storyboardId" TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  priority INTEGER NOT NULL DEFAULT 5,
  progress INTEGER NOT NULL DEFAULT 0,
  input TEXT,
  output TEXT,
  error TEXT,
  "modelProvider" TEXT,
  "modelName" TEXT,
  "workerId" TEXT,
  "startedAt" TEXT,
  "completedAt" TEXT,
  "timeoutAt" TEXT,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "maxRetries" INTEGER NOT NULL DEFAULT 3,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "pendingCharge" INTEGER,
  stage TEXT,
  "stageProgress" INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks("userId", status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks("projectId");

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  "taskId" TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events("taskId");

CREATE TABLE IF NOT EXISTS billing_ledger (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  description TEXT,
  "taskId" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_billing_user ON billing_ledger("userId");

CREATE TABLE IF NOT EXISTS system_configs (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  value TEXT,
  "updatedAt" TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  claimed_by TEXT,
  claim_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  heartbeat_at TEXT,
  completed_at TEXT,
  error TEXT,
  result TEXT,
  progress INTEGER DEFAULT 0,
  stage TEXT,
  progress_clips TEXT
);
CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS storyboard_versions (
  id TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "episodeId" TEXT NOT NULL,
  "shotIds" TEXT,
  snapshot TEXT NOT NULL,
  label TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sb_versions_episode ON storyboard_versions("episodeId");

CREATE TABLE IF NOT EXISTS provider_files (
  file_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  "api_config_id" TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);