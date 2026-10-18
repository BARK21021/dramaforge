# 批4 AnalyzingStage 实现报告

**日期**:2026-07-20
**分支**:`feat/cs-ui-slice`
**范围**:app1 AnalyzingStage.tsx（556行）→ dramaforge 完整复刻,替换 EpisodeWorkspace analyzing 阶段内联块

---

## 改动文件清单

| 文件 | 类型 | 行数变化 |
|------|------|----------|
| `packages/web/app/workspace/[projectId]/components/AnalyzingStage.tsx` | 新建 | +660 行 |
| `packages/web/app/workspace/[projectId]/components/EpisodeWorkspace.tsx` | 改 | -63/+20 行 |
| `packages/web/app/api/projects/[id]/episodes/[episodeId]/analyze/route.ts` | 改 | +2 行 |

---

## Q1 验证结果（costumeMap shape）

**验证方法**:读 app1 `F:\app1\src\core\ai\script-prompt.ts`（parseScriptResult 实际输出 shape）+ app1 AnalyzingStage.tsx（前端类型声明 + 渲染逻辑）+ dramaforge analyze/route.ts（scriptData 写入）

**验证结论**:
- app1 `parseScriptResult` 返回 `costumeMap: CostumeMapEntry[]`（数组,`{sceneId, character, costumeLabel, costumeDesc, isNew}[]`）,非 app1 前端类型声明的 `Record<string, Record<string, string>>`
- app1 route.ts:463 和 dramaforge route.ts:164 都直接写 `costumeMap: parsed.costumeMap`（无转换）
- app1 A9 造型表用 `Object.keys(costumeMap)` + `costumeMap[sceneKey][charName]` → 对数组 `Object.keys` 返回索引字符串 `["0","1",...]`,`costumeMap["0"][charName]` undefined → **app1 造型表实际渲染错乱/不渲染（latent bug）**

**同源 bug 发现**:
- app1 A8 信息点:前端读 `{title, content}` 但后端返回 `{type, description}` → 信息点显示空标题（fallback "信息点 N"）+ 空内容
- app1 A7 场景角色 chips:前端读 `s.characters` 但 `scriptData.scenes` 是 `SceneInfo[]`（无 characters 字段,route 只在顶层 `scenes` 字段写入 characters）→ 角色 chips 永不渲染

**dramaforge 处理方式**:
1. **costumeMap**:`narrowCostumeGroups()` 兼容层,数组 shape（`CostumeMapEntry[]`）→ `CostumeGroup[]`（按 sceneId 分组）,同时兼容 Record shape（防御性）。A9 用 `costumeGroups.flatMap` 重写渲染,rowSpan 逻辑保留
2. **infoPoints**:`readScriptData()` narrow 时防御性读 `p.type || p.title` + `p.description || p.content`,兼容两种 shape
3. **characters**:`scenes.map` 内派生 `allCharacters.filter(c => s.content?.includes(c))`,从 `scriptData.characters`（顶层）+ content 匹配派生每个 scene 的角色,对齐 route.ts:177 顶层 scenes 字段的派生逻辑

**修复效果**:造型表 / 信息点 / 角色 chips 三个 app1 latent bug 全部修复,行为对齐 app1 设计意图（app1 代码意图明确要展示这些,只是 bug 导致没渲染）

---

## 优化点采纳/不采纳清单

| 优化点 | 决策 | 实际处理 |
|--------|------|----------|
| OP1 costumeMap shape 修复 | 采纳 | `narrowCostumeGroups()` + A9 重写 |
| OP2 删 sortedScenes | 采纳 | 直接 `scenes.map` |
| OP3 删空 useEffect | 采纳 | 删除 |
| OP4 删 taskId 死代码 | 采纳 | 同步直连,无 analyzeTaskId state |
| OP5 抽 NavigateToAssetsButton | 采纳 | const 复用 A2+A11 |
| OP6 复用 barrel 类型 | 采纳 | EpisodeRecord from @dramaforge/shared + SceneInfo/InfoPoint/CostumeMapEntry from @dramaforge/server/prompt（subpath export 已验证）|
| OP7 readScriptData narrow | 采纳 | 对齐 InputStage readLocalizationProfile 模式 |
| OP8 统一折叠模式 | 不采纳 | 保持 A4 受控 + A10 原生 details |
| OP9 canEdit = !isReview | 采纳 | 4 处替换 |
| OP10 useMemo costumeGroups + allCharacters | 采纳 | React.useMemo |
| OP11 a11y | 采纳 | aria-expanded/aria-hidden |
| OP12 isCurrentlyAnalyzing 双源 | 不采纳 | 保留 `episode?.status === "ANALYZING" || analyzing` |
| OP13 enhancementDraft 持久化 | 不采纳 | 对齐 app1 不 warn 不持久化 |
| OP14 抽 useAnalyze hook | 不采纳 | AnalyzingStage 独立实现 |

**注**:coordinator 中途发紧急调整"砍掉所有非必要优化,赶工",但"已实现的优化保留不返工"。AnalyzingStage.tsx 已写完含 OP1-OP11 优化,保留不返工。

---

## typecheck + build 结果

**typecheck**:
```
cd packages/web && pnpm typecheck
```
- my files（AnalyzingStage.tsx / EpisodeWorkspace.tsx / analyze/route.ts）:0 error
- 仅 `test/sms-security.test.ts` 预存噪音 6 error（HeadersInit / NODE_ENV 类型,与批4 无关）

**build**:
```
set -a && source .env && set +a && cd packages/web && pnpm build
```
- ✓ Compiled successfully in 7.0s
- ✓ Generating static pages using 27 workers (30/30) in 753ms
- 零 error

---

## 视觉检查

**环境**:
- dev server（3000）Turbopack CSS crash（pre-existing Windows 环境问题 `0xc0000142`,与批4 无关）
- 改用 prod server（3002,`next start` + .env sourced）+ Electron UA 绕过 middleware（dramaforge C/S 设计:非 Electron UA 重定向 /download）

**测试数据**:
- 新建 `batch4-visual-user`（email batch4@test.local,password Test1234!）+ `batch4-proj`（DOMESTIC）+ `test-ep-batch4-visual`（rich scriptData:1 scene / 2 characters / 2 infoPoints / 2 costumeMap entries / rawAnalysis 194 字符 / modelUsed / analyzedAt）

**截图**（1 张关键截图 + 像素分析,vision skill 不可用因无 API key）:
- `C:/Users/<user>/batch4-content-full.png`（1440x1183,full page）

**vision skill 不可用**:`DASHSCOPE_API_KEY` / `DOUBAO_API_KEY` 均未配置,`OPENAI_API_KEY` 空。改用 page text dump + 像素分析替代。

**page text dump 验证**（11 个功能区块全部渲染）:
- A1 标题:"编剧分析" h2 + "1 个场景 · 2 个角色· 模型 deepseek/deepseek-v4-pro· 2026/7/20 20:00:00" ✓
- A2 顶部:"按实际 Token 结算" + "重新分析" + "进入资产设定" ✓
- A4 增强提示词卡:"分析增强提示词" + "指导角色/场景/资产提取方向（可选）"（collapsed）✓
- A7 场景列表:"场景列表 (1)" + 序号"01" + mono"S1" + 三 badge（采石场/夜/外）+ 出场角色 chips（阿灵/苍尘,派生成功）+ content ✓
- A8 信息点:"信息点 (2)" + "冲突升级" + 描述 + "伏笔" + 描述（type/description 读取成功）✓
- A9 造型表:"造型表 (1 场景)" + table（S1 → 阿灵/便装/风衣长裙… + 苍尘/战损/黑色劲装…/新造型,rowSpan 渲染正确）✓
- A10 原始分析折叠:"原始分析文本 (194 字符)" ✓
- A11 底部:"进入资产设定" 按钮 ✓

**像素分析**:
- amber/accent 像素（标题图标+badge）:rows 17-1168（199 rows）✓
- action blue 像素（按钮）:rows 21-1169（192 rows）✓
- 6 个 section 内容分布:section 1-5 100%,section 6 90%,无大空白区域 ✓
- 无严重溢出/截断/错位 ✓

**修复的问题清单**:无（视觉检查未发现需修复的布局问题,所有功能区块渲染正确）

---

## GC 自检

| GC | 状态 | 说明 |
|----|------|------|
| GC-1（BYOK 禁）| ✓ | POST /analyze body 仅 `{model, enhancementPrompt}`,无 key 字段 |
| GC-3（app1 只读）| ✓ | 仅镜像,未改任何 app1 文件 |
| GC-5（无新 .sql）| ✓ | analyzedAt 是 JSONB 字段追加,无 schema 变更 |
| GC-6（行为等价）| ✓ | A1-A11 全镜像 app1,数据 shape 修复对齐 app1 设计意图 |
| GC-7（架构差异行为等价）| ✓ | ProgressBar 替 GenerationProgress,同步直连替 taskId 异步 |
| GC-8（key 不入 git）| ✓ | 无 key 在代码/配置 |
| dramaforge-assets-client-local | ✓ | AnalyzingStage 纯文本/JSON 展示,无媒体字节 |
| dramaforge-keys-cloud-server-only | ✓ | 云端 key |
| dramaforge-frontend-align-app1 | ✓ | UI 1:1 镜像 app1 |
| prefer-better-lib-not-selfbuilt | ✓ | EmptyState/ProgressBar/Textarea/Button/Toast 全复用批0 UI 组件 |
| CLAUDE.md 视觉铁律 | ✓ | 截图 + 分析完成（vision skill 不可用用 text dump + 像素分析替代）|

---

## commit hash

`1e883bc` — `feat(cs-ui): 批4 AnalyzingStage 迁移 app1（A1-A11 全镜像+shape 修复）`

7 files changed, 1707 insertions(+), 103 deletions(-)

---

## 遗留/defer 项

| 功能 | defer 到 | 理由 |
|------|---------|------|
| isReview 只读模式 | 批9 | 接口保留,EpisodeWorkspace 暂传 false |
| GenerationProgress taskId 跟踪 | 永久 defer | dramaforge analyze route 同步直连,不返回 taskId |
| 跨集 previousEpisodes 注入 | T2b | 后端 route 大改,前端无影响 |
| 资产提取第二步 | 批5 assets | 后端 route 写 assets 表,属资产阶段范畴 |
| localizationProfile route body 接收 | 批4 顺手 / 批5 | 当前只在 episode.scriptData 读 |
| 计费 precheck/debit | 批9 | callAI 返回无 cost 字段 |
| test/sms-security.test.ts 预存 typecheck 噪音 | 收尾批 | 6 error 与批4 无关 |
| dev server Turbopack CSS crash | 收尾批/环境 | Windows 环境问题（0xc0000142）,与批4 无关,prod build 正常 |
