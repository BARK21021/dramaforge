-- ============================================================
-- 0005-platform-api-keys.sql
-- 平台级 API Key 池（admin 管理，全用户共享）+ 粘性 key 锁表（防多 key 轮转 403）
-- ============================================================
-- 背景：
--   GC-1 / dramaforge-keys-cloud-server-only：AI key 是平台云端服务器的，非 BYOK。
--   故 key 池是「平台级」—— api_configs."userId" IS NULL 表示平台 key（admin 管、
--   全用户共享），区别于 app1 的「用户级」(userId 非空)。
--   运行时 gateway/credentials.ts getCredential 先查平台池（加权轮询），池空回退 env。
-- 粘性 key 锁（provider_files）：
--   多 key 轮转时，文件用 key A 上传 → 归属账号 A → 后续若用 key B 访问 → 提供商
--   返回 403「不是文件所有者」。provider_files 记录 fileId → api_config_id 映射，
--   复用已上传文件时锁回原 key，从设计上规避 403（app1 没有此机制，是其潜在 bug）。
-- 幂等：可安全重复执行（IF EXISTS / IF NOT EXISTS 守卫）。
-- ============================================================

-- ① api_configs.userId 改可空：平台 key 用 NULL
--    （二次执行无副作用：DROP NOT NULL 对已可空列是 no-op）
ALTER TABLE api_configs ALTER COLUMN "userId" DROP NOT NULL;

-- ② 平台池查询加速：部分索引仅覆盖 userId IS NULL 的平台 key 行
CREATE INDEX IF NOT EXISTS idx_api_configs_platform
  ON api_configs(provider)
  WHERE "userId" IS NULL;

-- ③ 粘性 key 锁表：fileId → 上传它的 api_config（账号）
--    id 为 TEXT（对齐 api_configs.id TEXT 主键）
CREATE TABLE IF NOT EXISTS provider_files (
  file_id       TEXT PRIMARY KEY,                                          -- Moonshot 等返回的 fileId
  provider      TEXT NOT NULL,                                             -- 'kimi' 等
  api_config_id TEXT REFERENCES api_configs(id) ON DELETE SET NULL,       -- 删除该 key 时置空（回退轮询，不阻断）
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_provider_files_config ON provider_files(api_config_id);
