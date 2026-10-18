# P7.1 — 分集地基（工作台外壳 + episodes domain + 剧本输入）

**日期**：2026-07-19  **分支**：`feat/cs-ui-slice`  **前序**：P6（支付宝）

## 背景

P7（分镜体系对齐）是 app1→dramaforge 的最后一块功能差距。app1 工作台 UI 共
11,338 行（page.tsx + 9 个 Stage 组件），不可能一刀切 —— 拆 5 切片：

| 切片 | 内容 | 状态 |
|---|---|---|
| **P7.1** | 工作台外壳 + episodes domain + 剧本输入 | **本 slice** |
| P7.2 | 编剧分析（analyze-script AI） | 待做 |
| P7.3 | 资产生成（IMAGE_GENERATE / CHARACTER_PROFILE）+ AssetDesignStage | 待做 |
| P7.4 | 分镜生成（SHOT_AI）+ StoryboardStage + 镜头分组 | 待做 |
| P7.5 | 生产集成（VideoEditor 挂 P4 generate + P5 compile） | 待做 |

## 关键事实（recon 结论）

- **episodes 表早就在 dramaforge**（0001-init.sql，含 novelText/stageStatus/scriptData/
  sortOrder 全列）—— **本 slice 零迁移**。
- **asset / shot domain 全 CRUD 已就位**（大 C/S 重构遗留），episodes 是唯一
  缺 domain 的子域。
- **shots 外键 `ON DELETE CASCADE` → episodes**：删分集自动清镜头，无手动级联。
- **workflow/definitions.ts 9 步流水线定义已写好**（analyze→…→composite）。
- dramaforge project domain 只有 `listByUser/create`（P3），缺 `getById`（工作台要按
  id 加载）。

## 范围（in / out）

**In**：
- `shared/episode.ts` 契约（EpisodeRecord / 枚举 / create+update+reorder schema）
- `server/domain/episode/`（service+validation+index）—— listByProject/create
  （自动 episodeNumber）/getById/update（白名单 + stageStatus 单调推进）/remove
  /reorder
- `server/domain/project/` 加 `getById` + `update`（title/desc/status/category）
- web 路由：`GET/PATCH /api/projects/[id]`、`GET/POST /api/projects/[id]/episodes`
  （+`?reorder=1`）、`GET/PATCH/DELETE .../episodes/[episodeId]`
- web UI：`workspace/[projectId]/page.tsx` 外壳 + `EpisodeListStage`（建/编/
  删/↑↓排序/贴 novelText）

**Out（defer 到 P7.2+）**：AI 编剧分析（analyze）、分集拆分（split）、资产生图、
分镜生成、镜头分组、多 Tab stage 工作流、VideoEditor、成片库。

## 决策

1. **mapRow 私有**：episode/index.ts 不导出 mapRow/EpisodeRow，避免与 project
   的 mapRow 在 domain `export *` 时 TS2308 撞名（P6 payment 同款修复）。
2. **domain barrel 去掉 `export * from './episode'`**：episode 裸 `create` 撞
   project 裸 `create`；保留 `export * as episode` 命名空间，server 入口直连
   `./domain/episode` 不受影响。
3. **stageStatus 单调推进**：update 只允许前进（input→…→production），防回退
   —— 照搬 app1 getStageOrder 比较。
4. **NOW() 字面内联**（非参数化）：避免 pg 把 'NOW()' 字符串参数转 TIMESTAMPTZ
   失败；我硬编码无注入风险。
5. **contentKilo 由 novelText 同步重算**（create + update）—— 对齐 app1。
6. **视觉对齐 app1，像素非 gate**（同 P3/P4）：结构对 + 暗色 token 即可，用户
   测试机做视觉 QA。
7. **无 UI 组件单测**：dramaforge web 无 jsdom/RTL（node env），同 P3/P4 —— gate 靠
   路由测试 + typecheck + build。

## 验证

- server：typecheck 0 + 436 测试（+19 episode + 6 project getById/update）
- web：typecheck 0 + 157 测试（+19 三路由）+ next build 绿
  （`/api/projects/[id]`、`.../episodes`、`.../episodes/[episodeId]`、
  `/workspace/[projectId]` 全编译）
- client：typecheck 0 + 128 测试（barrel 改动无回归）

## 下一步

P7.2（编剧分析）：analyze-script 编排路由 + AI（STORY_ANALYZE taskType）+ 解析
场景/角色写入 episode.scriptData/scenes。需先验 ai-worker 是否真实现了
STORY_ANALYZE handler（workflow 定义有，执行未确认）。
