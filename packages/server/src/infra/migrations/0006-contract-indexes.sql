-- ============================================================
-- 0006：任务查询与平台多 Key 唯一性修正
-- ============================================================

-- GenerationProgress 使用 taskId 订阅 SSE，并以同一标识兜底查询作业状态。
-- user_id 用于所有权过滤，created_at DESC 支持在重复派发时优先取最近作业。
CREATE INDEX IF NOT EXISTS idx_render_jobs_task_user_created
  ON render_jobs(task_id, user_id, created_at DESC);

-- 任务中心每 5 秒按用户读取最近作业；user_id 必须是首列，否则上面的 taskId
-- 索引无法服务该查询，作业量增长后会退化为全表扫描与额外排序。
CREATE INDEX IF NOT EXISTS idx_render_jobs_user_created
  ON render_jobs(user_id, created_at DESC);

-- 平台环境 Key 的 label 固定为 env；同一 provider 可以有多把 Key，因此 env 记录
-- 改用 apiKey 区分。普通用户标签仍按 label 唯一，兼容已有的自定义标签语义。
DROP INDEX IF EXISTS idx_api_configs_user_provider_label;
CREATE UNIQUE INDEX idx_api_configs_user_provider_label
  ON api_configs(
    "userId",
    provider,
    (CASE WHEN label = 'env' THEN "apiKey" ELSE COALESCE(label, "apiKey") END)
  );
