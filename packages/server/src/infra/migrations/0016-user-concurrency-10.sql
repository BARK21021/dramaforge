-- ============================================================
-- 0016-user-concurrency-10.sql
-- ------------------------------------------------------------
-- 每用户并发任务上限 7 → 10（2026-07-31 用户要求「每个用户集数并发调到10」）
--
-- 背景：maxConcurrent 是「全局 per-user」上限（acquireSlot 按 userId 计数，
-- 不分 text/image/video/voice）。0011（3→7）后实战期用户要求进一步放宽到 10，
-- 一键出片批量生资产图 / 多集并发出片更顺，少撞「用户并发任务数已达上限（7/7）」。
-- 全局 worker 槽（text4/image16/video16/voice1）仍是真实吞吐上限，per-user 10
-- 只放宽单用户公平额度，不影响多用户间公平。
--
-- 注：getConcurrencyLimit 代码层 fallback 仍为 3（仅 user 不存在/DB 异常时），
-- 正常路径走 DB 值，本迁移已覆盖存量+默认（沿用 0011 不动 fallback 的保守约定）。
-- 幂等：UPDATE/ALTER SET DEFAULT 重复执行无副作用。
-- ============================================================

UPDATE users SET "maxConcurrent" = 10;
ALTER TABLE users ALTER COLUMN "maxConcurrent" SET DEFAULT 10;
