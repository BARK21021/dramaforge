-- 资产图片版本：服务器只存元数据/本地 sf-asset:// 引用，不存图片字节。
-- generationOrdinal 表示请求顺序，避免并发时用“最后完成”覆盖更新请求。
CREATE TABLE IF NOT EXISTS asset_image_revisions (
  id TEXT PRIMARY KEY,
  "assetId" TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  "projectId" TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  "generationOrdinal" INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'GENERATING',
  source TEXT NOT NULL DEFAULT 'AI',
  "modelName" TEXT,
  prompt TEXT,
  "providerUrl" TEXT,
  "localUrl" TEXT,
  error TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "committedAt" TIMESTAMPTZ,
  UNIQUE("assetId", "generationOrdinal")
);

CREATE INDEX IF NOT EXISTS idx_asset_image_revisions_asset_ordinal
  ON asset_image_revisions("assetId", "generationOrdinal" DESC);

