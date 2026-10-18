-- ============================================================
-- 0010-enforce-single-admin-key-pool.sql
-- 删除不再使用的用户级 Key，并从数据库层保证 API Key 只有管理员平台池一套来源。
-- ============================================================

-- 历史文件若粘在用户 Key 上，先解除引用；后续访问会重新进入管理员加权池。
UPDATE provider_files AS files
   SET api_config_id = NULL
 WHERE EXISTS (
   SELECT 1
     FROM api_configs AS configs
    WHERE configs.id = files.api_config_id
      AND configs."userId" IS NOT NULL
 );

-- 运行时已经不读取用户级 Key，删除全部隐藏残留，避免形成第二套凭证来源。
DELETE FROM api_configs
 WHERE "userId" IS NOT NULL;

-- 新写入也必须是管理员池记录；幂等检查允许迁移安全重复执行。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'api_configs_admin_pool_only'
       AND conrelid = 'api_configs'::regclass
  ) THEN
    ALTER TABLE api_configs
      ADD CONSTRAINT api_configs_admin_pool_only CHECK ("userId" IS NULL);
  END IF;
END
$$;
