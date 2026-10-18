-- ============================================================
-- 0001-init.sql — 初始 schema（从 app1 src/core/config/migrate.ts 整体移植）
-- ============================================================
-- 所有语句幂等（IF NOT EXISTS / ADD COLUMN IF NOT EXISTS），可重复执行。
-- 14 张业务表 + render_jobs 表（C/S 重构新增，客户端 render-worker 拉取）。
-- ============================================================

-- ============================================================
-- 用户表 (users)
-- 存储用户基本信息、认证信息、角色和积分
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                                    -- 用户唯一标识（UUID）
  email TEXT UNIQUE NOT NULL,                             -- 邮箱地址（唯一）
  name TEXT,                                              -- 用户昵称
  "avatarUrl" TEXT,                                       -- 头像 URL
  "passwordHash" TEXT,                                    -- 密码哈希（加密存储）
  role TEXT NOT NULL DEFAULT 'FREE',                      -- 用户角色：FREE/VIP/ADMIN
  credits INTEGER NOT NULL DEFAULT 100,                   -- 账户积分（用于计费）
  provider TEXT NOT NULL DEFAULT 'CREDENTIALS',           -- 认证方式：CREDENTIALS/GOOGLE/GITHUB
  "providerId" TEXT,                                      -- 第三方认证的用户 ID
  "maxConcurrent" INTEGER NOT NULL DEFAULT 3,             -- 最大并发任务数
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),         -- 创建时间
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),         -- 更新时间
  "lastLoginAt" TIMESTAMPTZ                               -- 最后登录时间
);

-- ============================================================
-- 用户偏好表 (user_preferences)
-- 存储用户的个性化设置（语言、主题等）
-- ============================================================
CREATE TABLE IF NOT EXISTS user_preferences (
  id TEXT PRIMARY KEY,                                    -- 偏好记录 ID
  "userId" TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 用户 ID（唯一，级联删除）
  locale TEXT NOT NULL DEFAULT 'zh',                      -- 语言偏好：zh/en/es
  theme TEXT NOT NULL DEFAULT 'dark',                     -- 主题偏好：dark/light
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),         -- 创建时间
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()          -- 更新时间
);
ALTER TABLE user_preferences ALTER COLUMN locale SET DEFAULT 'zh';

-- ============================================================
-- API 配置表 (api_configs)
-- 存储用户配置的 AI 服务商 API Key（支持同一 provider 多 key 池轮询）
-- ============================================================
CREATE TABLE IF NOT EXISTS api_configs (
  id TEXT PRIMARY KEY,                                    -- 配置记录 ID
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,         -- 用户 ID（级联删除）
  provider TEXT NOT NULL,                                 -- 服务商名称：openai/google/ark 等
  "apiKey" TEXT NOT NULL,                                 -- API Key（加密存储）
  "baseUrl" TEXT,                                         -- 自定义 API 地址（可选）
  "isEnabled" BOOLEAN NOT NULL DEFAULT TRUE,              -- 是否启用（用户手动开关）
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),         -- 创建时间
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()          -- 更新时间
);

-- ============================================================
-- api_configs 扩展：多 Key 池管理字段（幂等迁移）
-- ============================================================
-- 移除原 UNIQUE(userId, provider) 约束（允许同一 provider 配置多个 key）
-- 注：PostgreSQL 唯一约束名由 prisma 生成，带驼峰 userId，必须加双引号精确匹配
-- 否则 PG 会折叠成全小写 api_configs_userid_provider_key，匹配不到实际约束名
ALTER TABLE api_configs DROP CONSTRAINT IF EXISTS "api_configs_userId_provider_key";
DROP INDEX IF EXISTS "api_configs_userId_provider_key";

-- Key 池管理字段
ALTER TABLE api_configs ADD COLUMN IF NOT EXISTS label TEXT;                              -- Key 标签（如"主号""备用"）
ALTER TABLE api_configs ADD COLUMN IF NOT EXISTS weight INTEGER NOT NULL DEFAULT 1;      -- 权重（轮询选取概率）
-- 修复：keyStatus 未加引号被 PG 折叠成 keystatus，导致查询层（q() 加双引号精确匹配驼峰）找不到列
-- 已有库列名为 keystatus，先幂等 RENAME 为 "keyStatus" 保留数据；新库直接 ADD COLUMN
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_configs' AND column_name = 'keystatus'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_configs' AND column_name = 'keyStatus'
  ) THEN
    ALTER TABLE api_configs RENAME COLUMN keystatus TO "keyStatus";
  END IF;
END $$;
ALTER TABLE api_configs ADD COLUMN IF NOT EXISTS "keyStatus" TEXT NOT NULL DEFAULT 'active'; -- 系统状态：active|cooldown|disabled|invalid
ALTER TABLE api_configs ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMPTZ;               -- 最后使用时间
ALTER TABLE api_configs ADD COLUMN IF NOT EXISTS "errorCount" INTEGER NOT NULL DEFAULT 0; -- 累计错误数
ALTER TABLE api_configs ADD COLUMN IF NOT EXISTS "consecutiveFailures" INTEGER NOT NULL DEFAULT 0; -- 连续失败次数
ALTER TABLE api_configs ADD COLUMN IF NOT EXISTS "disabledUntil" TIMESTAMPTZ;            -- 冷却截止时间（cooldown 状态）
ALTER TABLE api_configs ADD COLUMN IF NOT EXISTS "lastErrorMessage" TEXT;                -- 最后错误信息
-- 单 Key 并发上限覆盖（NULL=回退 env.MAX_CONCURRENT_PER_API_KEY 全局默认；正整数=覆盖）
ALTER TABLE api_configs ADD COLUMN IF NOT EXISTS "maxConcurrent" INTEGER;

-- 软隔离：(userId, provider, label) 唯一，避免同 provider 下 label 重复
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_configs_user_provider_label
  ON api_configs("userId", provider, COALESCE(label, "apiKey"));

-- ============================================================
-- Seedance 参数预设模板表 (seedance_presets)
-- 存储用户级的高级参数模板，可跨项目复用、批量应用到多个组
-- ============================================================
CREATE TABLE IF NOT EXISTS seedance_presets (
  id TEXT PRIMARY KEY,                                    -- 模板 ID
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,         -- 用户 ID（级联删除）
  name TEXT NOT NULL,                                     -- 模板名称
  params JSONB NOT NULL,                                  -- seedanceGroupParams 快照（seed/resolution/aspectRatio/...）
  "isDefault" BOOLEAN NOT NULL DEFAULT FALSE,             -- 是否默认模板
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),         -- 创建时间
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),         -- 更新时间
  UNIQUE("userId", name)                                  -- 每个用户每个模板名唯一
);

-- ============================================================
-- 项目表 (projects)
-- 存储用户的视频风格化项目
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,                                    -- 项目 ID
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,         -- 所属用户 ID
  title TEXT NOT NULL,                                    -- 项目标题
  description TEXT,                                       -- 项目描述
  "novelText" TEXT,                                       -- 原始小说文本
  "scriptData" JSONB,                                     -- 剧本数据（JSON 格式）
  "artStyle" TEXT,                                        -- 项目风格锁定（realistic/anime2d/anime3d）
  "artStylePrompt" TEXT,                                  -- 用户自定义风格提示词
  status TEXT NOT NULL DEFAULT 'DRAFT',                   -- 项目状态：DRAFT/PROCESSING/COMPLETED
  version INTEGER NOT NULL DEFAULT 1,                     -- 版本号（用于乐观锁）
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),         -- 创建时间
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()          -- 更新时间
);
-- 索引：加速按用户和状态查询
CREATE INDEX IF NOT EXISTS idx_projects_userId ON projects("userId");
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- ============================================================
-- 分镜表 (storyboards) - 旧版
-- 存储项目的分镜信息（已被 shots 表替代，保留以兼容旧数据）
-- ============================================================
CREATE TABLE IF NOT EXISTS storyboards (
  id TEXT PRIMARY KEY,                                    -- 分镜 ID
  "projectId" TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,   -- 所属项目 ID
  episode INTEGER NOT NULL DEFAULT 1,                     -- 集数
  "shotIndex" INTEGER NOT NULL,                           -- 镜头序号
  "shotType" TEXT,                                        -- 镜头类型：远景/中景/近景/特写
  description TEXT NOT NULL,                              -- 镜头描述
  dialogue TEXT,                                          -- 对白内容
  duration REAL,                                          -- 时长（秒）
  "sortOrder" INTEGER NOT NULL DEFAULT 0,                 -- 排序序号
  metadata JSONB,                                         -- 元数据（JSON 格式）
  UNIQUE("projectId", episode, "shotIndex")               -- 每个项目的每集每个镜头序号唯一
);

-- ============================================================
-- 资产表 (assets)
-- 存储项目中的资产（角色、道具、场景等）
-- ============================================================
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,                                    -- 资产 ID
  "projectId" TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,   -- 所属项目 ID
  kind TEXT NOT NULL,                                     -- 资产类型：CHARACTER/PROP/LOCATION
  name TEXT NOT NULL,                                     -- 资产名称
  description TEXT,                                       -- 资产描述
  "imageUrl" TEXT,                                        -- 资产图片 URL
  metadata JSONB,                                         -- 元数据（JSON 格式）
  tags JSONB,                                             -- 标签列表（JSON 数组）
  "folderId" TEXT,                                        -- 文件夹 ID（用于分组）
  version INTEGER NOT NULL DEFAULT 1,                     -- 版本号
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),         -- 创建时间
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()          -- 更新时间
);
-- 索引：加速按项目和类型查询
CREATE INDEX IF NOT EXISTS idx_assets_project_kind ON assets("projectId", kind);

-- ============================================================
-- 资产表扩展字段（对齐 Frameos 业务模型）
-- 使用 ALTER TABLE ADD COLUMN IF NOT EXISTS 支持增量更新
-- ============================================================

-- 资产类型细分
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "assetType" TEXT;
-- 说明：CHARACTER: 主角/核心配角/配角/群演; PROP: 核心道具/普通物品; LOCATION: 内/外

-- 角色背景故事
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "background" TEXT;

-- 角色身份锁定特征（JSON 数组）
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "identityLock" JSONB;
-- 示例：["浅棕色齐肩发","浅蓝病号服"]

-- 角色音色特征描述
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "voiceTrait" TEXT;
-- 示例："年轻清脆，带有嘶吼、哭腔感"

-- 选定的音色 ID
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "voiceId" TEXT;

-- 音色来源
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "voiceSource" TEXT DEFAULT 'library';
-- 说明：library(平台候选) | upload(用户上传)

-- 试音状态
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "auditionStatus" TEXT DEFAULT 'idle';
-- 说明：idle/pending/completed/failed

-- 物品重要性描述
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "significance" TEXT;
-- 示例："用于捆绑束缚Luna的作案工具"

-- 环境类型（内/外）
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "intExt" TEXT;

-- 环境氛围描述
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "mood" TEXT;
-- 示例："压抑、阴冷"

-- 基础环境音描述
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "baseAmbience" TEXT;
-- 示例："空调运行的低沉嗡鸣声"

-- 资产生图主提示词
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "basePrompt" TEXT;

-- 资产是否已确认
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "isConfirmed" BOOLEAN DEFAULT FALSE;

-- 覆盖场景列表（JSON 数组）
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "coverageScenes" JSONB;
-- 示例：["S01E01_SC01", ...]

-- 角色关系（JSON 数组）
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "relationships" JSONB;
-- 示例：[{from, to, type, detail}]

-- 设计图信息（JSON 对象）
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "designImage" JSONB;
-- 示例：{material_id, url, status}

-- 资产级彩铅风格开关（启用后该角色参考图以彩铅版本进入视频生成）
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "pencilPaintEnabled" BOOLEAN DEFAULT FALSE;
-- 示例：true | false

-- 资产级稀疏网格开关（NULL 跟随全局 gridEnabled；TRUE 显式开启；FALSE 显式关闭）
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "gridOverlayEnabled" BOOLEAN;
-- 示例：true | false | null

-- 彩铅版图片 URL（不覆盖 imageUrl，右下角缩略图来源）
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "pencilImageUrl" TEXT;

-- 网格预览图 URL（本期不写入，预留未来 UI 预览）
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "gridImageUrl" TEXT;

-- 角色造型变体列表（CHARACTER 专用，JSON 数组）
-- 同一角色在不同场景穿不同服装时，每个造型对应一个变体，可独立生图
-- 结构：[{ key, label, description, identityLock, imageUrl, coverageScenes }]
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "costumes" JSONB;

-- 角色绑定的全局声纹 ID（CHARACTER 专用）
-- @deprecated 已废弃，停止写入。保留用于读取历史数据。改用 characterId
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "voiceprintId" TEXT;

-- 角色绑定的全局角色 ID（CHARACTER 专用，替代 voiceprintId）
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "characterId" TEXT;

-- 重新生成锁：true=已锁定，禁止 AI 重新生图；资产确认时自动设为 true，需手动解锁才能重新生成
ALTER TABLE assets ADD COLUMN IF NOT EXISTS "regenLocked" BOOLEAN NOT NULL DEFAULT FALSE;

-- 视频转剧本草稿（独立于 novelText，用于刷新后恢复"生成剧本输出"卡片，不自动覆盖主文本框）
ALTER TABLE projects ADD COLUMN IF NOT EXISTS "videoScriptDraft" TEXT;
-- 注意：episodes 表的 videoScriptDraft ALTER 已移至 episodes CREATE TABLE 之后，
-- 避免全新数据库上 ALTER 先于 CREATE 导致 "relation episodes does not exist" 错误

-- ============================================================
-- 任务表 (tasks)
-- 存储异步任务（AI 生成、视频处理等）
-- ============================================================
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,                                    -- 任务 ID
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,         -- 所属用户 ID
  "projectId" TEXT REFERENCES projects(id) ON DELETE SET NULL,           -- 关联项目 ID（项目删除时置空）
  "storyboardId" TEXT REFERENCES storyboards(id) ON DELETE SET NULL,    -- 关联分镜 ID（分镜删除时置空）
  type TEXT NOT NULL,                                     -- 任务类型：IMAGE_GEN/VIDEO_GEN/TTS 等
  status TEXT NOT NULL DEFAULT 'PENDING',                 -- 任务状态：PENDING/PROCESSING/COMPLETED/FAILED
  priority INTEGER NOT NULL DEFAULT 5,                    -- 优先级（1-10，数字越小优先级越高）
  progress REAL NOT NULL DEFAULT 0,                       -- 进度百分比（0-100，支持小数）
  input JSONB,                                            -- 输入参数（JSON 格式）
  output JSONB,                                           -- 输出结果（JSON 格式）
  error TEXT,                                             -- 错误信息
  "modelProvider" TEXT,                                   -- 使用的 AI 服务商
  "modelName" TEXT,                                       -- 使用的模型名称
  "workerId" TEXT,                                        -- 执行任务的 Worker ID
  "startedAt" TIMESTAMPTZ,                               -- 开始时间
  "completedAt" TIMESTAMPTZ,                             -- 完成时间
  "timeoutAt" TIMESTAMPTZ,                               -- 超时时间
  "retryCount" INTEGER NOT NULL DEFAULT 0,                -- 已重试次数
  "maxRetries" INTEGER NOT NULL DEFAULT 3,                -- 最大重试次数
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),         -- 创建时间
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()          -- 更新时间
);
-- 索引：加速任务调度和查询
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks("userId", status);
CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority);
CREATE INDEX IF NOT EXISTS idx_tasks_type_status ON tasks(type, status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks("projectId");
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks("createdAt");

-- ============================================================
-- 任务事件表 (task_events)
-- 持久化任务生命周期事件，支持 SSE 快照、断线重放和页面刷新后恢复
-- ============================================================
CREATE TABLE IF NOT EXISTS task_events (
  id BIGSERIAL PRIMARY KEY,                               -- 事件自增 ID（供 Last-Event-ID 重放）
  "taskId" TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,         -- 关联任务 ID
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,         -- 任务所属用户 ID
  "eventType" TEXT NOT NULL,                              -- 事件类型：status_change/progress/output/error
  payload JSONB NOT NULL,                                 -- 完整事件载荷
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()          -- 事件创建时间
);
CREATE INDEX IF NOT EXISTS idx_task_events_user_id_id
  ON task_events("userId", id);
CREATE INDEX IF NOT EXISTS idx_task_events_task_id_id
  ON task_events("taskId", id);
CREATE INDEX IF NOT EXISTS idx_task_events_created_at
  ON task_events("createdAt");

-- ============================================================
-- s8 安全加固：tasks 待补扣字段
-- ============================================================
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "pendingCharge" JSONB;
CREATE INDEX IF NOT EXISTS idx_tasks_pending_charge ON tasks("pendingCharge") WHERE "pendingCharge" IS NOT NULL;

-- ============================================================
-- 计费流水表 (billing_ledger)
-- 记录用户的积分消费和充值流水
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_ledger (
  id TEXT PRIMARY KEY,                                    -- 流水 ID
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,         -- 用户 ID
  "taskId" TEXT,                                          -- 关联任务 ID（可选）
  type TEXT NOT NULL,                                     -- 流水类型：CONSUME/RECHARGE/REFUND
  amount INTEGER NOT NULL,                                -- 变动金额（正数为充值，负数为消费）
  balance INTEGER NOT NULL,                               -- 变动后余额
  credits INTEGER NOT NULL,                               -- 本次消耗的积分
  description TEXT,                                       -- 流水描述
  metadata JSONB,                                         -- 元数据（JSON 格式）
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()          -- 创建时间
);
-- 索引：加速按用户和时间查询
CREATE INDEX IF NOT EXISTS idx_billing_user_created ON billing_ledger("userId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_billing_task ON billing_ledger("taskId");

-- 补齐 updatedAt 列（database.ts 的 create() 会自动写入该字段，原表缺失导致插入失败）
ALTER TABLE billing_ledger ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ============================================================
-- s5 安全加固：billing_ledger 防重放部分唯一索引
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_ledger_user_task_type_unique
  ON billing_ledger("userId", "taskId", type)
  WHERE "taskId" IS NOT NULL;

-- ============================================================
-- 系统配置表 (system_configs)
-- 存储全局的系统配置（键值对形式）
-- ============================================================
CREATE TABLE IF NOT EXISTS system_configs (
  id TEXT PRIMARY KEY,                                    -- 配置 ID
  key TEXT UNIQUE NOT NULL,                               -- 配置键（唯一）
  value TEXT,                                             -- 配置值
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()          -- 更新时间
);

-- ============================================================
-- Frameos 业务流程新增表 (MVP)
-- 支持分集、镜头、素材的精细化管理
-- ============================================================

-- ============================================================
-- 分集表 (episodes)
-- 存储项目的分集信息（剧本、场景、视觉风格等）
-- ============================================================
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,                                    -- 分集 ID
  "projectId" TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,   -- 所属项目 ID
  "episodeNumber" INTEGER NOT NULL DEFAULT 1,             -- 集数序号
  title TEXT,                                             -- 分集标题
  content TEXT,                                           -- 完整分集剧本内容
  "contentKilo" INTEGER,                                  -- 字数（千字）
  status TEXT NOT NULL DEFAULT 'PENDING',                 -- 状态：PENDING|ANALYZING|COMPLETED|CONFIRMED
  "defaultVisualStyle" JSONB,                             -- 默认视觉风格 { name, description }
  scenes JSONB,                                           -- 场景列表 [{ scene_id, characters[], visual_style }]
  "emotionArc" TEXT,                                      -- 情绪弧线描述
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),         -- 创建时间
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),         -- 更新时间
  UNIQUE("projectId", "episodeNumber")                    -- 每个项目的每集序号唯一
);

-- 视频转剧本草稿（从原位置移至此处，确保 episodes 表已创建）
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS "videoScriptDraft" TEXT;

-- 剧本分级管理：为 episodes 表扩展独立输入文本和五阶段状态字段
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS "novelText" TEXT;
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS "stageStatus" TEXT NOT NULL DEFAULT 'input';
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS "scriptData" JSONB;
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- ============================================================
-- 声纹全局映射：为 projects 表扩展 voiceprintMapping 字段
-- @deprecated 已废弃，停止写入。保留用于读取历史数据。改用 characterMapping
-- ============================================================
ALTER TABLE projects ADD COLUMN IF NOT EXISTS "voiceprintMapping" JSONB;

-- ============================================================
-- 角色全局映射：为 projects 表扩展 characterMapping 字段（替代 voiceprintMapping）
-- ============================================================
ALTER TABLE projects ADD COLUMN IF NOT EXISTS "characterMapping" JSONB;

-- ============================================================
-- 超长视频转剧本任务进度持久化
-- ============================================================
ALTER TABLE projects ADD COLUMN IF NOT EXISTS "longVideoProgress" JSONB;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS "artStyle" TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS "artStylePrompt" TEXT;

-- ============================================================
-- 单集声纹分析结果：为 episodes 表扩展 voiceprintAnalysis 字段
-- @deprecated 已废弃，停止写入。保留用于读取历史数据。改用 characterAnalysis
-- ============================================================
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS "voiceprintAnalysis" JSONB;

-- ============================================================
-- 单集角色分析结果：为 episodes 表扩展 characterAnalysis 字段（替代 voiceprintAnalysis）
-- ============================================================
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS "characterAnalysis" JSONB;

-- ============================================================
-- 镜头表 (shots)
-- 替代原 storyboards 表，提供更详细的分镜信息
-- ============================================================
CREATE TABLE IF NOT EXISTS shots (
  id TEXT PRIMARY KEY,                                    -- 镜头 ID
  "projectId" TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,   -- 所属项目 ID
  "episodeId" TEXT REFERENCES episodes(id) ON DELETE CASCADE,           -- 所属分集 ID
  "sceneId" TEXT,                                         -- 所属场景 ID
  "shotSeq" TEXT,                                         -- 镜头序号（如 S01-SEG01）
  "shotIndex" INTEGER NOT NULL,                           -- 镜头索引（数字）
  "durationSeconds" REAL,                                 -- 镜头时长（秒）
  "visualPrompt" TEXT,                                    -- AI 生成的视频提示词
  "stylePrompt" TEXT,                                     -- 风格描述
  "aspectRatio" TEXT DEFAULT '9:16',                      -- 画面比例（默认竖屏 9:16，如 16:9, 1:1）
  "resolution" TEXT,                                      -- 分辨率（如 1080p, 4K）
  "purposeTag" TEXT,                                      -- 镜头目的：情绪加压/推进信息/制造冲突/反转钩子/交代行动
  "emotionArcPosition" TEXT,                              -- 情绪弧线位置：建场/推进/高潮/回落
  "montageType" TEXT,                                     -- 蒙太奇类型：积累/平行/交叉等
  "audioType" TEXT,                                       -- 音频类型：对白/环境音/音乐/静默
  "referencedAssets" JSONB,                               -- 引用的资产 { characters[], speakingCharacters[], items[], environments[] }
  "currentMaterialId" TEXT,                               -- 当前选中的素材 ID
  "currentMaterialUrl" TEXT,                              -- 当前选中的素材 URL
  "videoStatus" TEXT DEFAULT 'PENDING',                   -- 视频生成状态：PENDING|GENERATING|COMPLETED|FAILED
  status TEXT NOT NULL DEFAULT 'PENDING',                 -- 镜头状态：PENDING|CONFIRMED
  "sortOrder" INTEGER NOT NULL DEFAULT 0,                 -- 排序序号
  metadata JSONB,                                         -- 元数据（JSON 格式）
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),         -- 创建时间
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),         -- 更新时间
  UNIQUE("projectId", "episodeId", "shotIndex")           -- 每个项目的每集每个镜头索引唯一
);
-- 索引：加速按项目和分集查询
CREATE INDEX IF NOT EXISTS idx_shots_project ON shots("projectId");
CREATE INDEX IF NOT EXISTS idx_shots_episode ON shots("episodeId");
-- 镜头默认画幅改为竖屏 9:16（适配手机短视频），幂等更新已有数据库的列默认值
ALTER TABLE shots ALTER COLUMN "aspectRatio" SET DEFAULT '9:16';

-- ============================================================
-- 素材历史表 (materials)
-- 记录每个镜头的多次生成历史
-- ============================================================
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,                                    -- 素材 ID
  "shotId" TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,         -- 所属镜头 ID（级联删除）
  "projectId" TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,   -- 所属项目 ID
  "materialType" TEXT NOT NULL,                           -- 素材类型：VIDEO|IMAGE|AUDIO
  "materialUrl" TEXT NOT NULL,                            -- 素材 URL
  "modelProvider" TEXT,                                   -- 使用的 AI 服务商
  "modelName" TEXT,                                       -- 使用的模型名称
  params JSONB,                                           -- 生成参数（JSON 格式）
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()          -- 创建时间
);
-- 索引：加速按镜头查询
CREATE INDEX IF NOT EXISTS idx_materials_shot ON materials("shotId");

-- ============================================================
-- 注册系统改造：手机号注册支持
-- ============================================================
-- 1) 放宽 email 约束：手机注册用户 email 为 NULL
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- 2) 新增 phone 字段（完整国际格式 +8613800138000）
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

-- 单设备登录限制：当前会话印章。每次登录覆盖；requireAuth 比对 JWT 印章，不一致则判定别处登录、踢出当前会话。
ALTER TABLE users ADD COLUMN IF NOT EXISTS "activeSessionStamp" TEXT;

-- 3) phone 唯一索引（部分索引，允许多个 NULL；老邮箱用户 phone=NULL 不冲突）
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique
  ON users(phone) WHERE phone IS NOT NULL;

-- 4) phone 索引加速登录查询
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;

-- ============================================================
-- 用户偏好扩展：UI 偏好（按钮风格预设等）
-- ============================================================
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS "uiPrefs" JSONB;

-- ============================================================
-- 项目分类与剧本共享（三类项目架构）
-- ============================================================
ALTER TABLE projects ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT 'DOMESTIC';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS "sourceProjectId" TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS "scriptOverride" BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_projects_category ON projects("category");
CREATE INDEX IF NOT EXISTS idx_projects_sourceProjectId ON projects("sourceProjectId");

-- ============================================================
-- render_jobs 表（C/S 重构新增）
-- 客户端 render-worker 通过 GET /api/render/jobs/next 原子认领（FOR UPDATE SKIP LOCKED），
-- 本机 ffmpeg 处理后回传 result/failed。服务器不跑 ffmpeg。
-- ============================================================
CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  input JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  claimed_by TEXT,
  claim_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT,
  result JSONB
);
CREATE INDEX IF NOT EXISTS idx_render_jobs_status_created ON render_jobs(status, created_at) WHERE status = 'PENDING';
