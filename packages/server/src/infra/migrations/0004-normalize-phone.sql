-- ============================================================
-- 0004-normalize-phone.sql — 手机号格式统一为 +86 国际格式（I7）
-- ============================================================
--
-- 背景：
--   createUserFromPhone / auth.ts 写入的是 +8613800138000（11 位国内 + +86 前缀）；
--   但 scripts/app1-data.sql（从 app1 导入的存量用户）phone 列是 11 位纯数字。
--   → 同一现实用户在 DB 里可能存在两条记录（一条 +86 一条 11 位），UNIQUE(phone)
--   形同虚设，findUserByPhoneOrEmail 不得不做多格式 OR 兼容。
--
-- 改造：
--   1) 一次性 UPDATE：将 phone 列中匹配 ^1[3-9]\d{9}$ 的 11 位国内号改写为 +86 前缀。
--      已经是 +86 或 NULL 的行不受影响；email 列存有 11 位号的旧脏数据也一并收敛到 phone。
--   2) 添加 CHECK 约束 phone IS NULL OR phone LIKE '+86%'，
--      DB 层兜底防止今后再写入 11 位纯数字。
--
-- 幂等：
--   - UPDATE 的 WHERE 限定 11 位模式，重复执行只改 0 行。
--   - DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT 重复执行不报错。
--
-- 依赖前置：0001-init.sql 已创建 users.phone 列与 idx_users_phone_unique 部分唯一索引。
-- ============================================================

-- 1) 把 phone 列里 11 位国内号改写为 +86 前缀国际格式
UPDATE users
SET phone = '+86' || phone
WHERE phone IS NOT NULL
  AND phone ~ '^1[3-9][0-9]{9}$';

-- 2) 兼容历史"手机号误写入 email"的存量账户：email 是 11 位国内号、phone 仍为 NULL
--    的，搬到 phone 列（+86 前缀）并清空 email，避免下一次 findUserByPhoneOrEmail
--    重新引入多格式 OR。
UPDATE users
SET phone = '+86' || email,
    email = NULL
WHERE phone IS NULL
  AND email IS NOT NULL
  AND email ~ '^1[3-9][0-9]{9}$';

-- 3) 表级 CHECK 约束：phone 必须是 +86 前缀国际格式或 NULL
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_format_check;
ALTER TABLE users
  ADD CONSTRAINT users_phone_format_check
  CHECK (phone IS NULL OR phone LIKE '+86%');
