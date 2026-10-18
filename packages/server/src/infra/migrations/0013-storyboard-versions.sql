-- 分镜整集历史版本：重生/恢复时把当前整集 shots 快照归档（不删）。
-- 单位 = 整集（重生是一次性替换整集镜头，区别于 asset_image_revisions 的单行级）。
-- JSONB 快照对 shots 表零侵入——listShots / computeGroups / group-preview /
-- chain-generate / getEpisodesCompletionMap / 渲染派发等所有读 shots 处都无需改动。
-- 模式仿 0007-asset-image-revisions.sql（ordinal + UNIQUE + CASCADE），作用域是整集。
CREATE TABLE IF NOT EXISTS storyboard_versions (
  id              TEXT PRIMARY KEY,
  "episodeId"     TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  "projectId"     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,            -- 该集归档序号，MAX+1 单调递增，不回填不复用
  shots_snapshot  JSONB   NOT NULL,            -- 完整 ShotRecord[] 快照（含 currentMaterialUrl/metadata）
  shot_count      INTEGER NOT NULL,            -- 冗余：列表展示用，免解包 JSONB
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE("episodeId", ordinal)
);

CREATE INDEX IF NOT EXISTS idx_storyboard_versions_episode_ordinal
  ON storyboard_versions("episodeId", ordinal DESC);
