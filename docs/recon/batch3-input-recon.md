# 批3 InputStage Recon Brief

> 范围:把 app1 InputStage 完整功能(双 Tab / Word 上传 / 文本转风格 / 视频转剧本 / ProgressBar)
> 从 `F:\app1` 复刻到 dramaforge `D:\dramaforge-cs`,替换 EpisodeWorkspace 内联 textarea。
>
> 模式: read-only recon + 写 brief。本文件**不**包含代码改动,只产出实现步骤+翻译规则。
>
> 硬约束(GC): GC-1(BYOK 禁)/GC-3(F:\app1 只读)/GC-5(无新 .sql)/GC-6/7/8(翻译规则)
> + dramaforge-assets-client-local(媒体只存客户端)/dramaforge-keys-cloud-server-only(key 只在云端)
> + dramaforge-frontend-align-app1(视觉对齐 app1)/prefer-better-lib-not-selfbuilt(用现成库不自研)。
>
> **视觉检查铁律**(CLAUDE.md): 实现完成后必须用 `browser-harness` 截图(全页 + 滚动 2-3 张)
> + vision skill 分析(对齐/间距/溢出/留白/截断),汇总问题清单。本 brief 在每条 UI 项末尾
> 标 **[VIS-CK]** 提示视觉检查点。

---

## 1. app1 InputStage 完整功能清单(8 条)

来源: `F:\app1\src\app\workspace\[projectId]\components\InputStage.tsx`(713 行)+ `LanguageMenu.tsx`(136 行)。

### F1. 双 Tab pill 切换(文本输入 / 视频转剧本)
- 顶部 `mode === "text" | "video"` 切换(行 99, 434-461)。
- pill 样式: 选中 `bg-[var(--action-dim)] text-[var(--action)]`,未选 `text-[var(--text-3)]`。
- 集号 > 1 时右上角提示 `第 N 集 · 跨集资产已传递`(行 456-460)。
- **[VIS-CK]**: pill 对齐 / 选中色 / 第 N 集徽标位置。

### F2. Word 文档上传(import-docx)
- 触发: EditorSurface `meta` 区的 `📄 上传 Word` label(行 538-554),`accept=".docx"`,`hidden input`。
- 校验: 必 `.docx` 后缀,≤ 20MB(行 405-412)。
- 调用: `POST /api/projects/${projectId}/import-docx`,FormData `file` 字段(行 415-420)。
- 响应: `{ text: string, chars: number }` → 写入 `scriptDraft`(行 421-423)。
- 错误: 行内红色提示(行 590-594)。
- 不落盘文件,只解析为纯文本(后端用 `mammoth.extractRawText`)。

### F3. 文本转风格(text-to-style) + LanguageMenu
- 触发条件: `showTextToStyle = !isDomestic`(行 175)— 即 OVERSEAS 或 ORIGINAL 才显示,DOMESTIC 不显示。
- OVERSEAS 必选: `details open={isOverseas}`,错误色 `text-[var(--error)]`(行 470-484)。
- LanguageMenu(OVERSEAS 用): popover 搜索 + 区域网格(行 491-500)。选中后写入
  `stylePrompt = "${l.zh} / ${l.cultureHint} / ${l.region}"`(行 496-497)。
- 自由 Textarea(ORIGINAL 用): 行 502-508。
- 调用: `POST /api/projects/${projectId}/text-to-style`,JSON body
  `{ text, stylePrompt, model, existingAssets, episodeNumber }`(行 204-214)。
- 响应: `{ script, localizationProfile, rawLength, aliasMap }`(行 215-225)→ 写 `scriptDraft` + `lastStyledSnapshotRef`。
- "转换风格 · 按实际 Token 结算" 按钮(行 516-526)。
- 跨集资产传递: 第二集及之后传入 `existingAssets`(由父组件 EpisodeWorkspace 提供)。

### F4. 保存并分析(ProgressBar 多阶段)
- 触发: "保存并分析" 按钮(行 608-620),`canSave = scriptDraft ≥ 10 字符 && !saving && !styling && (!isOverseas || stylePrompt 非空)`(行 177-181)。
- OVERSEAS 流程(行 254-271): 先自动执行 `performTextToStyle`(若 lastStyledSnapshot 不匹配当前输入),
  ProgressBar 阶段: 8%("准备文本转风格") → 35%("已完成风格转换") → 45%("保存剧本内容") → 72%("启动 AI 编剧分析") → 100%("分析任务已提交")。
- DOMESTIC/ORIGINAL 流程: 12%("保存剧本内容") → 45% → 72% → 100%。
- 步骤 1: `PATCH /api/projects/${projectId}/episodes/${episodeId}` body `{ novelText, scriptData: { ..., localizationProfile } }`(行 280-293)。
- 步骤 2: `POST /api/projects/${projectId}/episodes/${episodeId}/analyze` body `{ model, localizationProfile }`(行 299-302)。
- 成功 → `onRefresh({force:true})` + `onNavigateNext()` 切到 analyzing 阶段。
- ProgressBar 组件: `pulse` 动画,`completed` 状态切换(行 624-635)。

### F5. 视频转剧本(video-to-script)
- 触发: mode === "video" + 拖拽/点击上传(行 671-695)。
- 校验: `ALLOWED_VIDEO_MIME = ["video/mp4","video/webm","video/quicktime","video/x-matroska"]`
  + 扩展名 `.mp4/.webm/.mov/.mkv`,≤ 100MB(行 93-96, 337-347)。
- 调用: `POST /api/projects/${projectId}/video-to-script`,multipart `video` + `episodeId` + `episodeNumber`(行 349-353)。
- 响应有两种:
  - `{ taskId }` → 异步,设 `videoTaskId` + `trackTaskId`(行 362-365),用 `GenerationProgress` 组件轮询(行 644-649)。
  - `{ script }` → 同步返回(短视频),直接写 `scriptDraft` + 切回 text 模式(行 366-372)。
- 完成回调 `handleVideoComplete`(行 384-394): untrackTaskId + onRefresh + 切回 text。
- 上传假进度: `setInterval` 800ms,递增到 88%(行 183-189, 654-668)— 因接口不返回真实百分比。

### F6. LanguageMenu 组件(136 行,海外专用)
- 34 种语言(`TARGET_LANGUAGES`,区域分组: 东亚/东南亚/南亚/中东/欧洲日耳曼/欧洲罗曼/欧洲斯拉夫/其他)。
- popover: 顶部搜索框(支持 zh/native/en/code 模糊匹配)+ 区域 2 列网格(行 90-134)。
- 选中项高亮 `bg-[var(--action-dim)]`,区域小标题 `text-[var(--text-3)]`(行 116-122)。
- 点击外部 / Esc 关闭(行 30-44)。

### F7. 初始化 + 状态恢复
- 初次加载: 从 `episode.novelText || episode.content || episode.videoScriptDraft` 填 `scriptDraft`(行 157-161)。
- 已持久化的本地化档案恢复: `episode.scriptData.localizationProfile` → `stylePrompt` + `targetLang`(行 164-169)。
- `lastStyledSnapshotRef` 防止保存时重复转换(行 146-150)。

### F8. 错误展示 + 字符计数
- EditorSurface footer: 行数 + 字符数 + canSave 状态文案(行 563-576)。
- `docxError` / `videoError`: 红底错误条(行 590-594, 698-703)。
- 海外必选提示: 多处 `text-[var(--error)]` 警示文案(行 510-514, 600-604)。

---

## 2. dramaforge 现状 gap

### 2.1 前端 gap(EpisodeWorkspace 内联)
位置: `D:\dramaforge-cs\packages\web\app\workspace\[projectId]\components\EpisodeWorkspace.tsx`

| 功能 | app1 | dramaforge 现状 | gap |
|------|------|----------|-----|
| 输入 UI | 双 Tab pill + EditorSurface + LanguageMenu | 内联 `<textarea>`(行 593-599) | **缺** Tab / EditorSurface / 风格区 / Word 上传 |
| 保存分析 | ProgressBar 多阶段 8%→100% | toast + spinner | **缺** ProgressBar |
| 文本转风格 | 完整(OVERSEAS 必选) | 无 | **全缺** |
| Word 上传 | 完整 | 无 | **全缺** |
| 视频转剧本 | 完整 | 无 | **全缺**(建议 defer,见 §5) |

现状 input 阶段渲染: 行 583-611(42 行)。handleAnalyze: 行 327-367(PATCH novelText + POST analyze,无 ProgressBar)。

### 2.2 后端 route gap
位置: `D:\dramaforge-cs\packages\web\app\api\projects\[id]\`

| Route | app1 | dramaforge | 状态 |
|-------|------|------|------|
| `[episodeId]/analyze` POST | ✓ | ✓(已实现,批2) | **复用** |
| `[episodeId]` PATCH | ✓ | ✓(已实现,批2,scriptData 在白名单) | **复用** |
| `import-docx` POST | ✓(mammoth) | ❌ | **新建** |
| `text-to-style` POST | ✓(gateway + buildTextStylePrompt) | ❌ | **新建** |
| `video-to-script` POST | ✓(kimi + Whisper + OCR + ffmpeg) | ❌ | **defer**(见 §5) |

确认: Grep `import-docx|text-to-style|video-to-script` 命中 2 处 —
仅 `docs/REPLICATE-APP1-PLAN.md` + `packages/server/src/domain/prompt/script-prompt.ts`(注释提及),
**0 个实际 route 文件存在**。

### 2.3 dramaforge 已有可复用基础设施(批0/批2)
- `lib/api.ts`(批2 C): useApi + apiPost/apiPatch + envelope 解析,**FormData body 自动不加 Content-Type**(行 222-228)。
- `lib/models.ts`(批0): LANGUAGE_MODELS 含 `deepseek/deepseek-v4-pro` + `deepseek/deepseek-v4-flash`(行 98-127)。
- `lib/stage-config.ts`(批2): STAGES / StageKey / deriveStageFromEpisode。
- `hooks/useTaskStatus.ts`(批0): useSSE + trackTaskId/untrackTaskId(供 video 异步任务用,defer 场景才用)。
- `components/ui/Button.tsx` / `Input.tsx`(Textarea) / `EditorSurface.tsx` / `ProgressBar.tsx` / `EmptyState.tsx`: 全部就绪。
- `packages/server/src/domain/prompt/target-languages.ts`(已移植): TARGET_LANGUAGES(34 种)+ LocalizationProfile + buildLocalizationProfile + parseTargetLanguage。
- `packages/server/src/domain/prompt/script-prompt.ts:722` `buildTextStylePrompt` + 行 975 `cleanAiOutput` — **dramaforge 已有,直接复用**。
- `packages/server/src/gateway/index.ts:81` `callAI(provider, model, payload)` — 统一入口,GC-1 key 云端。
- `packages/web/lib/response.ts`: apiSuccess / apiFail / handleApiError envelope(GC-4)。
- `packages/shared/src/project.ts:68`: `category: z.enum(['ORIGINAL','DOMESTIC','OVERSEAS'])` — ProjectCategory 类型已就绪。

---

## 3. 实现步骤

### Step 1: 新建 LanguageMenu 组件
- **文件**: `D:\dramaforge-cs\packages\web\app\workspace\[projectId]\components\LanguageMenu.tsx`(新)。
- **来源**: 1:1 镜像 app1 `LanguageMenu.tsx`(136 行)。
- **import 调整**:
  - app1: `from "@/core/ai/target-languages"` → dramaforge: `from "@dramaforge/server"`(domain/prompt/target-languages 已 export)。
  - app1: `from "@/components/ui/cn"` → dramaforge: 用现有 className 拼接或新建轻量 `cn` util(检查 components/ui/ 下是否已有 cn.ts;若无,直接模板字符串拼接,行 75-80 的 cn 调用改为三元表达式)。
- **TARGET_LANGUAGES / TargetLanguage 类型**: 从 `@dramaforge/server` import(确认 packages/server/src/domain/prompt/index.ts 已 re-export,若未 re-export 则实现 agent 补 export)。
- **[VIS-CK]**: popover 位置 / 搜索框 focus / 区域网格 2 列 / 选中态高亮。

### Step 2: 新建 InputStage 组件
- **文件**: `D:\dramaforge-cs\packages\web\app\workspace\[projectId]\components\InputStage.tsx`(新)。
- **来源**: 1:1 镜像 app1 `InputStage.tsx`,**砍掉 F5 视频转剧本相关**(mode 简化为仅 "text",详见 §5 defer)。
- **import 调整**:
  - app1 `@/components/ui/Button` → dramaforge `../../../../components/ui/Button`(对齐 EpisodeWorkspace:36)。
  - app1 `@/components/ui/Input`(Textarea) → dramaforge `../../../../components/ui/Input`。
  - app1 `@/components/ui/EmptyState` → dramaforge `../../../../components/ui/EmptyState`。
  - app1 `@/components/ui/ProgressBar` → dramaforge `../../../../components/ui/ProgressBar`。
  - app1 `@/components/ui`(EditorSurface/CodeTextarea) → dramaforge `../../../../components/ui/EditorSurface`(确认 EditorSurface 是否 export CodeTextarea;若无,改用 `<textarea>` + 自带行号渲染,或扩展 EditorSurface props)。
  - app1 `@/components/features`(GenerationProgress) → **不 import**(video defer,无需此组件)。
  - app1 `@/hooks/useTaskStatus`(trackTaskId/untrackTaskId) → **不 import**(video defer)。
  - app1 `./LanguageMenu` → dramaforge `./LanguageMenu`(本批 Step 1 新建)。
  - app1 `@/core/ai/target-languages`(类型) → dramaforge `@dramaforge/server`。
- **Props 调整**:
  - 保留: `projectId / episodeId / episode / api / scriptModel / onRefresh / onNavigateNext / className / existingAssets / category`。
  - 砍掉: video 相关 state(videoTaskId/videoUploading/videoUploadProgress/videoError/handleVideoUpload/handleVideoComplete)。
  - 砍掉: `mode === "video"` 分支渲染,顶部 Tab pill 简化为单 Tab(仅"文本输入")或保留双 Tab 但"视频转剧本"为禁用状态(显示"即将上线")。
- **API URL 路径**: app1 用 `/api/projects/${projectId}/...`,dramaforge 用 `/api/projects/${encodeURIComponent(projectId)}/...`(对齐 EpisodeWorkspace:194)。
- **[VIS-CK]**: 风格转换 details 折叠 / 海外必选红色提示 / EditorSurface 行号对齐 / ProgressBar 多阶段。

### Step 3: 改造 EpisodeWorkspace input 阶段
- **文件**: `D:\dramaforge-cs\packages\web\app\workspace\[projectId]\components\EpisodeWorkspace.tsx`(改)。
- **改动点**:
  - 行 583-611 的内联 `<section>` 替换为 `<InputStage projectId={projectId} episodeId={episodeId} episode={episode} category={project?.category ?? 'DOMESTIC'} api={api} scriptModel={scriptModel} existingAssets={projectAssets} onRefresh={() => loadEpisode({force:true})} onNavigateNext={() => syncStageView('analyzing')} />`。
  - 删除 `handleAnalyze`(行 327-367)中 input-stage 相关逻辑(analyzing 阶段重新分析按钮可保留,但走 InputStage 内部 handler 或独立 handler)。
  - 删除 `draftNovel` state(行 230)— 移到 InputStage 内部。但 analyzing 阶段的"重新分析"按钮需要能触发,故保留 `handleAnalyze` 作为 re-analyze 入口,InputStage 内部保存分析走自己的 handler(对齐 app1)。
  - 新增 props/state: `projectAssets`(从 `GET /api/projects/[id]/assets` 拉,filtered by isConfirmed)+ `project.category`(从 episode.projectId 反查或父组件透传)。
- **projectAssets 拉取**: 在 EpisodeWorkspace 内新增 `loadProjectAssets` useCallback + useEffect,过滤 `kind IN ('CHARACTER','PROP','LOCATION')` 且 `isConfirmed === true`,map 到 `{kind, name, description}[]` 传给 InputStage.existingAssets。
- **category 获取**: EpisodeWorkspace 当前未拉 project 详情。新增 `loadProject` 拉一次 `GET /api/projects/[id]` 取 `category` 字段(或扩展 episode 返回 project.category,但避免改 schema → 用独立 GET)。
- **[VIS-CK]**: input 阶段整页布局 / 模型选择条 + 阶段进度条 + InputStage 的纵向流。

### Step 4: 新建后端 import-docx route
- **文件**: `D:\dramaforge-cs\packages\web\app\api\projects\[id]\import-docx\route.ts`(新)。
- **HTTP**: `POST /api/projects/[id]/import-docx`。
- **请求**: multipart/form-data,字段 `file`(.docx,≤ 20MB)。
- **响应**: `200 { success:true, data: { text: string, chars: number } }`。
- **错误**: 400(非 .docx / 超 20MB / 空文档) / 401 / 404(项目不存在)。
- **实现**: 1:1 镜像 app1 `import-docx/route.ts`。
  - 用 `requireUser()` 替代 app1 `requireAuth(request)`(dramaforge 模式,见 episode/[episodeId]/analyze/route.ts:70)。
  - 用 `projectRepo.getById()` 替代 `prisma.project.findUnique()`。
  - 用 `apiSuccess({text, chars})` / `apiFail({error, code}, status)` 替代 app1 envelope helpers。
  - mammoth: `npm install mammoth` 到 `packages/web/package.json`(route 在 web 包)。
    - prefer-better-lib-not-selfbuilt: **不自研** docx 解析器,mammoth 是 app1 已验证的方案,直接用。
  - Next.js 14 app router 默认 body 大小限制 1MB;**必须**在 `next.config.js`(或 route 内 `export const maxDuration`)配置允许 20MB multipart:
    - route 内 `export const runtime = 'nodejs'; export const maxDuration = 60; export const dynamic = 'force-dynamic';`(对齐 app1:23-25)。
    - 若仍超限,在 `next.config.web.ts` 加 `experimental.serverActions.bodySizeLimit: '25mb'` 或同等 multipart 配置(实现 agent 验证后定)。
- **GC 翻译**:
  - dramaforge-assets-client-local: .docx **不是媒体资产**(是剧本源文档),服务器内存解析后丢弃字节,只把提取的文本写入 episode.novelText(已有的 PATCH 路径)。**符合 GC** — 不在 server/MinIO 持久化 .docx 字节。
  - dramaforge-keys-cloud-server-only: 此 route 无 key 调用,纯解析。**符合 GC**。

### Step 5: 新建后端 text-to-style route
- **文件**: `D:\dramaforge-cs\packages\web\app\api\projects\[id]\text-to-style\route.ts`(新)。
- **HTTP**: `POST /api/projects/[id]/text-to-style`。
- **请求**: application/json,字段:
  ```ts
  {
    text: string;               // 必填,≥10 字符,≤ 200000
    stylePrompt: string;         // 必填,≤ 5000
    model?: string;              // 默认 'deepseek/deepseek-v4-pro'
    existingAssets?: Array<{kind, name, description}>;  // 前端传入(跨集)
    episodeNumber?: number;      // >1 时触发服务端 DB 资产合并
  }
  ```
- **响应**: `200 { success:true, data: { script: string, localizationProfile: LocalizationProfile, rawLength: number, aliasMap: Record<string,string> } }`。
- **错误**: 400(text 过短/过长 / stylePrompt 空 / DOMESTIC 项目不允许) / 401 / 404 / 502(AI 失败)。
- **实现**: 1:1 镜像 app1 `text-to-style/route.ts`(行 36-204),关键调用:
  1. `requireUser()` + ownership 校验(`projectRepo.getById` + `userId === auth.userId`)。
  2. DOMESTIC 项目拒绝:`if (project.category === 'DOMESTIC') return apiFail({error:'国内直出项目不需要文本转风格', code:'BAD_CATEGORY'}, 400)`。
  3. episodeNumber > 1 时服务端拉项目资产合并去重(app1:71-101)。dramaforge 用 `assetRepo.listByProject(projectId, {kind IN ('CHARACTER','PROP','LOCATION')})` 替代 raw SQL(确认 assetRepo 已有 listByProject 方法;若无,实现 agent 临时用 `prisma.$queryRaw` 等价 — dramaforge 用原生 pg,改用 `query('SELECT kind, name, description FROM assets WHERE "projectId"=$1 AND kind IN (...)')`)。
  4. `buildTextStylePrompt(text, stylePrompt, existingAssets, episodeNumber)` → `{system, user}`(**dramaforge 已有**,script-prompt.ts:722)。
  5. `callAI(provider, model, { capability:'text_generation', input:{messages:[{system},{user}], temperature:0.7}, userId })`(替代 app1 gateway.request)。
     - provider 从 model 拆分: 复用 analyze route 的 `parseModel()` 函数(行 57-63),建议抽到 lib 共享。
  6. `cleanAiOutput(aiRawText)`(**dramaforge 已有**,script-prompt.ts:975)。
  7. `buildLocalizationProfile(stylePrompt)`(**dramaforge 已有**,target-languages.ts:104)。
  8. 写 project.scriptData.localizationProfile(app1 是写 project;dramaforge 决策见 §6.Q1)。
  9. parseCharacterAliasMap + updateVoiceprintRoleIdentityByAliasMap: **defer**(声纹映射批3 范围外,dramaforge 无 voiceprintRepo;返回空 aliasMap 占位)。
- **GC 翻译**:
  - BYOK(GC-1): callAI 用云端 key,不读用户 api-config。**符合 GC**。
  - dramaforge-keys-cloud-server-only: 同上。
  - 文本模型 catalog: deepseek/deepseek-v4-pro(LANGUAGE_MODELS 已含)。**符合 GC**。
- **[VIS-CK]**: 无直接 UI(route 层),但前端调用结果影响 InputStage scriptDraft 填充,需端到端截图验证。

### Step 6: 后端 video-to-script route
- **defer** — 详见 §5。

### Step 7: 视觉检查(强制,CLAUDE.md)
- 启 dev server,打开任一 episode 的 input 阶段 URL。
- `browser-harness` new_tab(url) → wait_for_load → sleep(2) → capture_screenshot(全页)。
- 滚动到风格区 / EditorSurface / 按钮区,各截 1 张。
- 每张用 `python ~/.claude/skills/vision/vision.py` 分析(对齐/间距/溢出/留白/截断/空白区域)。
- 输出乱码用 GBK 解码: `open(path,'rb').read().decode('gbk')`。
- 汇总问题清单 → 实现 agent 修复 → 复检。

---

## 4. 翻译规则(每条 app1 功能 → dramaforge 映射,引用 GC)

### T1. 视频转剧本(F5)— **DEFER**
- **app1 行为**: 客户端 multipart 上传 100MB video → 服务器 processVideoToScriptCore(Kimi + Whisper + OCR,服务端 ffmpeg 抽音频 / 抽帧)→ 写 episode.videoScriptDraft。
- **GC 冲突**:
  - dramaforge-assets-client-local: 100MB video 字节流经服务器违反"媒体资产只存 Electron 客户端本地"。即便服务器处理完丢弃,上传过程仍占用服务器带宽 / 临时内存。
  - dramaforge-cs-refactor: "ffmpeg 挪 Electron 客户端"— Whisper 依赖 ffmpeg 抽音频,服务端无 ffmpeg。
- **dramaforge 翻译**: **批3 不实现**。InputStage 双 Tab 的"视频转剧本" Tab 显示为禁用状态(`disabled` + 提示"即将上线"),保留 UI 占位但 mode 状态不可切到 video。
- **未来实现方向(供 defer 批次参考)**:
  - 方案 A: Electron 客户端本地 ffmpeg 抽音频 + 关键帧 → 客户端发起 multipart 到 dramaforge 服务器(只传音频 mp3 + 几张 jpg,体量 < 5MB)→ 服务器调 Kimi(音频 + 图像多模态)→ 返回剧本。**符合 GC**(音频/图像不是完整视频,但仍涉小字节流;需评估是否仍违反 assets-local)。
  - 方案 B: 客户端 Electron 本地起 HTTP server,Kimi 服务端回调拉流(架构复杂,defer)。
  - 推荐方案 A,defer 到批3.5 或批7 production 阶段统一规划。

### T2. Word 上传 .docx(F2)
- **app1 行为**: 服务器 `mammoth.extractRawText({arrayBuffer})` 解析 .docx 字节 → 返回纯文本 → 服务器不落盘。
- **GC 翻译**:
  - dramaforge-assets-client-local: .docx **不是媒体资产**,是剧本源文档。服务器解析后只把提取的文本写入 episode.novelText(DB 文本字段)。.docx 字节不持久化到 MinIO/磁盘。**符合 GC**(字节仅在请求生命周期内存中存在,响应后 GC)。
  - prefer-better-lib-not-selfbuilt: 直接用 mammoth(app1 验证过),不自研 docx 解析器。**符合 GC**。
- **dramaforge 实现**: Step 4,1:1 镜像。

### T3. 文本转风格 catalog 模型(F3)
- **app1 行为**: `scriptModel = 'deepseek/deepseek-v4-pro'`(默认),`gateway.request({capability:'text_generation', model, ...})`。
- **GC 翻译**:
  - BYOK(GC-1): InputStage 无 api-config UI,只有 ModelSelector 选模型。**确认 InputStage.tsx:107-118 无 key UI**(只 scriptModel prop)。**符合 GC**。
  - dramaforge-keys-cloud-server-only: callAI 用云端 key(getCredential 读环境变量 / DB 平台 key)。**符合 GC**。
  - catalog: LANGUAGE_MODELS 已含 deepseek-v4-pro / v4-flash。**符合 GC**。
- **dramaforge 实现**: Step 5,callAI 替代 gateway.request。

### T4. 跨集 existingAssets(F3)
- **app1 行为**: 父组件 EpisodeWorkspace 传入项目已确认资产(全量),前端 body 传给 text-to-style route;route 第二集及之后还从 DB 自动合并 CHARACTER/PROP/LOCATION 资产(app1:71-101)。
- **dramaforge 翻译**: 保留双轨:
  - 前端 EpisodeWorkspace 拉 `GET /api/projects/[id]/assets?confirmed=true` 传给 InputStage.existingAssets。
  - 后端 text-to-style route 第二集及之后用 `query('SELECT ... FROM assets WHERE "projectId"=$1 AND kind IN (...)')` 自动合并。
- **GC 兼容**: 资产数据(非媒体字节)— character/prop/location 的 name + description 是文本元数据,允许在服务器 DB + 通过 API 传到客户端。**符合 GC**(assets-local 限媒体字节,不限 DB 文本元数据)。

### T5. ffmpeg(F5)— **DEFER 与 T1 一致**
- video-to-script 在 app1 涉 ffmpeg(Whisper 抽音频)。dramaforge 已把 ffmpeg 挪到 Electron 客户端。**确认批3 不做 video-to-script**,故批3 零 ffmpeg 依赖。**符合 GC**(dramaforge-cs-refactor)。

### T6. ProgressBar 多阶段(F4)
- **app1 行为**: `stageProgressLabel / stageProgressStage / stageProgressValue` 三 state,8%→35%→45%→72%→100%。
- **dramaforge 翻译**: 直接复用 `components/ui/ProgressBar.tsx`(批0 已移植)。ProgressBar props 应已支持 `progress / label / stage / pulse / completed / showPercent`(实现 agent 验证;若 props 不齐则扩展)。
- **GC 兼容**: 纯 UI,无 GC 冲突。

---

## 5. 风险 + defer 项

### D1. 视频转剧本(F5 + T1 + T5)— **DEFER 到批3.5 或批7**
- 原因: GC 冲突(assets-client-local)+ ffmpeg 客户端化 + 100MB 上传架构重设。
- 占位: InputStage 双 Tab 的"视频转剧本" Tab 禁用 + "即将上线"提示。
- defer 批次建议: 批3.5(若主链稳定后单开)或批7 production(与 chain-generate 串生成统一规划媒体流)。

### D2. GenerationProgress 组件 — **DEFER 与 D1 联动**
- app1 InputStage 行 644-649 用 GenerationProgress 跟踪 videoTaskId。dramaforge **未移植**此组件(Grep 仅命中 REPLICATE-APP1-PLAN.md 文档)。
- 批3 不做 video → 不需要此组件。defer 到 video-to-script 落地批次一起移植。

### D3. 跨集 existingAssets 服务端合并 — **批3 保留(不 defer)**
- app1 text-to-style route 行 71-101 的 DB 自动合并逻辑复杂但有价值(避免跨集角色重命名)。
- dramaforge 实现: 用原生 pg `query()` 替代 `prisma.$queryRaw`,逻辑等价。批3 范围内可实现。
- 风险: assetRepo 是否已有按 kind 过滤的 list 方法。若无,实现 agent 临时用 `query()` raw SQL(不新增 repo 方法,避免扩面)。

### D4. parseCharacterAliasMap + updateVoiceprintRoleIdentityByAliasMap — **DEFER**
- app1 text-to-style route 行 173-186 的声纹映射回写。dramaforge 无 voiceprintRepo / voiceprint-service。
- 批3 占位: text-to-style route 返回空 `aliasMap: {}`,跳过声纹回写。
- defer 到声纹相关批次(批6 或更后,与配音 production 一起)。

### D5. mammoth 依赖 + body size limit — **风险(批3 内解决)**
- mammoth npm 包是纯 JS,无原生二进制,安装无风险。
- Next.js 14 app router 默认 body limit 1MB,**必须**配置 20MB 上限。
- 实现 agent 需验证: route 内 `export const maxDuration = 60; export const dynamic = 'force-dynamic';` 是否足够,或需 `next.config` 调 `bodySizeLimit`(实现时实测)。

### D6. project.category 获取路径 — **风险(批3 内解决)**
- EpisodeWorkspace 当前未拉 project 详情(只 episode + shots + episodes 列表)。
- 批3 实现: 新增 `loadProject` 拉 `GET /api/projects/[id]` 取 category,或扩展 episode GET 返回 project.category(避免改 schema → 用独立 GET 更稳)。
- 风险: 多一次网络请求。可缓存到 ref 避免重复拉。

### D7. CodeTextarea 子组件 — **风险(批3 内解决)**
- app1 EditorSurface 内部用 CodeTextarea(行号 + 正文对齐)。dramaforge EditorSurface 是否 export CodeTextarea 待确认。
- 若未 export: 简化为标准 `<textarea>`,丢失行号;或扩展 EditorSurface props 接受 children 渲染策略。
- 实现 agent 优先读 dramaforge EditorSurface.tsx 源码决策。

---

## 6. 依赖确认

### 批0 已就绪(catalog / hooks)
- `lib/models.ts`: LANGUAGE_MODELS(deepseek-v4-pro / v4-flash)— **用** InputStage scriptModel 默认值。
- `hooks/useTaskStatus.ts`: trackTaskId / untrackTaskId — **不用**(video defer)。
- `components/ui/{Button, Input, EditorSurface, ProgressBar, EmptyState}.tsx`: **全用** InputStage。

### 批2 已就绪(EpisodeWorkspace / useApi / stage-config)
- `lib/api.ts`: useApi + apiPost / apiPatch — **用** InputStage 内部 handler 调 API。
- `lib/stage-config.ts`: STAGES / StageKey / syncStageView — **用** EpisodeWorkspace onNavigateNext 切到 analyzing。
- EpisodeWorkspace.tsx: **改**(Step 3)— 替换内联 textarea 为 InputStage 组件。
- analyze route + episode PATCH route: **复用**(批2 已实现)。

### InputStage 具体 import 清单(供实现 agent)
```ts
// dramaforge InputStage.tsx 顶部 import
import * as React from "react";
import { Button } from "../../../../components/ui/Button";
import { Textarea } from "../../../../components/ui/Input";
import { EmptyState } from "../../../../components/ui/EmptyState";  // 仅在需要时
import { ProgressBar } from "../../../../components/ui/ProgressBar";
import { EditorSurface /* , CodeTextarea */ } from "../../../../components/ui/EditorSurface";
import { LanguageMenu } from "./LanguageMenu";
import type {
  LocalizationProfile,
  TargetLanguage,
} from "@dramaforge/server";
// 类型从 server domain/prompt/target-languages re-export(实现 agent 确认 prompt/index.ts 已 re-export)
```

---

## 7. 实现后的验收清单(recon agent 不验,实现 agent 验)

- [ ] LanguageMenu 34 种语言全显示,搜索 + 区域分组正常。
- [ ] OVERSEAS 项目: 风格区红色必选提示 + 保存分析前自动转风格。
- [ ] DOMESTIC 项目: 风格区隐藏(不显示 details)。
- [ ] ORIGINAL 项目: 风格区显示但用 Textarea(非 LanguageMenu)。
- [ ] Word 上传 .docx ≤ 20MB → 文本填入 scriptDraft;.doc / 超 20MB → 错误提示。
- [ ] 保存并分析: ProgressBar 8%→35%→45%→72%→100% 正常推进;失败回滚到 input。
- [ ] 视频转剧本 Tab: 禁用 + "即将上线"提示(defer)。
- [ ] 第 N 集(N>1)右上角徽标 + existingAssets 跨集传递。
- [ ] **视觉检查**(CLAUDE.md): 截图 + vision skill 分析,问题清单归零。

---

## 8. 待实现 agent 决策的开放问题

### Q1. localizationProfile 存哪?
- app1: 写 project.scriptData.localizationProfile(项目级共享)。
- dramaforge 选项:
  - (a) project.scriptData.localizationProfile — 跨集共享同一目标语种(对齐 app1)。
  - (b) episode.scriptData.localizationProfile — 每集独立(dramaforge 是 episode-centric B 方案)。
- **recon 建议**: 选 (a) project 级。理由: 海外转绘项目所有集应锁定同一目标语种(避免每集翻译成不同语种);与 app1 行为一致;dramaforge analyze route 已支持读 project.scriptData.localizationProfile(批2 analyze route 注释行 22-25 提及 defer 项"localizationProfile 海外转绘",批3 补上)。
- 实现 agent 决策: 若选 (a),需在 project service 加 `updateScriptData` 方法或扩展 PATCH project route 接受 scriptData 字段(检查 project service 当前是否支持 scriptData 写入 — service.ts:187 注释"JSONB / 脚本字段留给后续"提示当前未支持,需补)。

### Q2. parseModel 函数复用
- dramaforge analyze route 已有 `parseModel`(行 57-63),但定义在 route 文件内(私有)。
- text-to-style route 也需要同样的拆分逻辑。
- **recon 建议**: 抽到 `packages/web/lib/model-parser.ts`(或 `packages/server/src/gateway/parse-model.ts`),两个 route 共享。实现 agent 决策位置。

### Q3. EditorSurface CodeTextarea 子组件
- 需实现 agent 读 dramaforge `EditorSurface.tsx` 源码确认是否 export CodeTextarea。
- 若无: 简化方案 InputStage 直接用 `<textarea>`(class 模拟 CodeTextarea 样式),或扩展 EditorSurface。
- **recon 建议**: 优先简化(用 textarea + 行数计数 footer),避免扩 EditorSurface 增加批3 范围。

---

## 9. 文件清单(实现 agent 待动)

### 新建(4 个)
1. `D:\dramaforge-cs\packages\web\app\workspace\[projectId]\components\LanguageMenu.tsx`(新,~136 行)
2. `D:\dramaforge-cs\packages\web\app\workspace\[projectId]\components\InputStage.tsx`(新,~500 行 — 砍 video 后比 app1 713 行精简)
3. `D:\dramaforge-cs\packages\web\app\api\projects\[id]\import-docx\route.ts`(新,~75 行)
4. `D:\dramaforge-cs\packages\web\app\api\projects\[id]\text-to-style\route.ts`(新,~180 行)

### 改造(1 个)
5. `D:\dramaforge-cs\packages\web\app\workspace\[projectId]\components\EpisodeWorkspace.tsx`(改 — input 阶段内联 textarea 替换为 InputStage + 新增 loadProject / loadProjectAssets)

### 不动(复用)
- 批2 analyze route / episode PATCH route / catalog / hooks / UI 组件 / target-languages / script-prompt(buildTextStylePrompt + cleanAiOutput)/ gateway callAI。

### 依赖安装
- `mammoth`(加到 `packages/web/package.json`)。

---

**recon 完成**。本 brief 不含代码改动。实现 agent 按本 brief Step 1-7 执行,优先完成 Step 1-5(主链),
Step 6(video-to-script)defer,Step 7 视觉检查强制执行(CLAUDE.md)。
