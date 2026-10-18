-- ============================================================
-- 0009-promote-existing-platform-keys.sql
-- 将 C/S 切换前已有的 Kimi / DeepSeek / ARK 用户级 Key 纳入管理员平台池。
-- ============================================================
--
-- 历史 app1 把同一批平台 Key 按用户保存，C/S 则以 userId IS NULL 表示平台池。
-- 每个 provider + apiKey 只提升一条代表记录，再删除同 Key 的用户绑定副本；
-- 最终只有管理员平台池这一套记录。NOT EXISTS 使迁移可重复执行，且不会
-- 复制或在日志中输出任何 Key。
-- ============================================================

WITH representatives AS (
  SELECT DISTINCT ON (legacy.provider, legacy."apiKey") legacy.id
    FROM api_configs legacy
   WHERE legacy."userId" IS NOT NULL
     AND legacy.provider IN ('kimi', 'deepseek', 'ark')
     AND NOT EXISTS (
       SELECT 1
         FROM api_configs platform
        WHERE platform."userId" IS NULL
          AND platform.provider = legacy.provider
          AND platform."apiKey" = legacy."apiKey"
     )
   ORDER BY legacy.provider, legacy."apiKey",
            legacy."isEnabled" DESC,
            (legacy."keyStatus" = 'active') DESC,
            legacy."updatedAt" DESC,
            legacy.id
)
UPDATE api_configs target
   SET "userId" = NULL,
       label = COALESCE(NULLIF(target.label, ''), '迁移已有 Key'),
       "updatedAt" = NOW()
 FROM representatives
 WHERE target.id = representatives.id;

-- 提升完成后，同 provider + Key 的旧用户副本只会造成界面重复和绕过权重，直接清理。
DELETE FROM api_configs legacy
 WHERE legacy."userId" IS NOT NULL
   AND legacy.provider IN ('kimi', 'deepseek', 'ark')
   AND EXISTS (
     SELECT 1
       FROM api_configs platform
      WHERE platform."userId" IS NULL
        AND platform.provider = legacy.provider
        AND platform."apiKey" = legacy."apiKey"
   );

-- 数据库级保证管理员池内同一 provider 不会重复保存同一个 Key。
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_configs_platform_unique_key
  ON api_configs(provider, "apiKey")
  WHERE "userId" IS NULL AND provider IN ('kimi', 'deepseek', 'ark');
