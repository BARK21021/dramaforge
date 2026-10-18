-- 图片版本必须记录所属造型。否则任务刷新/断线恢复时只能把所有版本误认成主图，
-- 造型图会写错位置，造型历史也无法正确激活。
ALTER TABLE asset_image_revisions
  ADD COLUMN IF NOT EXISTS "costumeKey" TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_asset_image_revisions_asset_costume_ordinal
  ON asset_image_revisions("assetId", "costumeKey", "generationOrdinal" DESC);
