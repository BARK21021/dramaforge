-- 0014-render-job-progress.sql
-- 持久化 render_job 的实时进度（progress / stage），根治 CHAIN_COMPILE 进度假死。
--
-- 背景：/progress 路由此前只 markRunning（status+heartbeat）+ 发 SSE，progress/stage
-- 从不落库；状态恢复端点 GET /api/tasks/[taskId] 又把 progress 写死 0。结果链一刷新 /
-- SSE 断 / 直接查行 → 0% 假死，曾导致误判 cancel 健康推进中的链。
-- 现让 /progress 每次上报把 progress+stage 写入行，任何读取都看到真实"生成第 N/12 组·X%"。
--
-- ADD COLUMN ... DEFAULT 在 PG 上是元数据级、非阻塞；IF NOT EXISTS 幂等。
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS stage TEXT;
