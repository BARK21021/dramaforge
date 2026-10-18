-- ============================================================
-- 0011-user-concurrency-7.sql
-- ------------------------------------------------------------
-- 每用户并发任务上限 3 → 7（2026-07-23 实战期用户要求）
--
-- 背景：maxConcurrent 是「全局 per-user」上限（acquireSlot 按 userId 计数，
-- 不分 text/image/video/voice）。原值 3 时一键出片批量生资产图频繁撞
-- 上限（"用户并发任务数已达上限（3/3）"）。调到 7 让批量生图更顺。
-- 全局 worker 槽（text4/image16/video16/voice1）仍是真实吞吐上限，per-user 7
-- 只放宽单用户公平额度。
--
-- 注：getConcurrencyLimit 代码层 fallback 仍为 3（仅 user 不存在/DB 异常时），
-- 正常路径走 DB 值，本迁移已覆盖存量+默认。
-- 幂等：UPDATE/ALTER SET DEFAULT 重复执行无副作用。
-- ============================================================

UPDATE users SET "maxConcurrent" = 7;
ALTER TABLE users ALTER COLUMN "maxConcurrent" SET DEFAULT 7;
