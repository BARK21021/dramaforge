# 批4 AnalyzingStage Recon Brief

> 范围:把 app1 AnalyzingStage 完整功能(场景列表 / 信息点 / 造型表 / 原始分析折叠 / 增强提示词卡 /
> 重新分析 / 进入资产设定 / 空状态 / 只读提示)从 `F:\app1` 复刻到 dramaforge `D:\dramaforge-cs`,
> 替换 EpisodeWorkspace analyzing 阶段内联块(批2 D 留下的 ~65 行简陋场景列表)。
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

## 1. app1 AnalyzingStage 完整功能清单(11 条)

来源: `F:\app1\src\app\workspace\[projectId]\components\AnalyzingStage.tsx`(556 行)。
后端来源: `F:\app1\src\app\api\projects\[projectId]\episodes\[episodeId]\analyze\route.ts`(964 行)。
父组件挂载: `F:\app1\src\app\workspace\[projectId]\components\EpisodeWorkspace.tsx`(行 800-810 透传 props)
+ `F:\app1\src\app\workspace\[projectId]\page.tsx`(行 159-165 持有 `analyzeEnhancementPrompt` state + localStorage 持久化)。

### A1. 标题区(h2 琥珀色 svg + 副标题)
- `<h2>` 含 `svg` 琥珀色(`var(--accent)`)图标 + "编剧分析" 文案 + `var(--font-display)`(行 233-239)。
- 副标题三段动态拼接(行 240-252):
  - 有分析时: `{scenes.length} 个场景 · {allCharacters.length} 个角色`
  - 附加 `· 模型 {scriptData.modelUsed}`(若 modelUsed 存在)
  - 附加 `· {new Date(scriptData.analyzedAt).toLocaleString("zh-CN", { hour12: false })}`(若 analyzedAt 存在)
  - 无分析时: "解析场景结构与角色信息"
- **[VIS-CK]**: h2 字号/字重 / 琥珀图标对齐 / 副标题中点分隔符间距 / 时间格式化渲染。

### A2. 顶部操作区(按实际 Token 结算 + 重新分析 + 进入资产设定)
- 左副标题右侧 `flex-shrink-0` 操作区(行 254-286):
  - `!isReview` 时显示 "按实际 Token 结算" 灰色提示(行 256-258)。
  - `!isReview` 时显示 "重新分析" 按钮 `variant="outline"`(行 261-279):
    - 分析中(`isCurrentlyAnalyzing`): 显示 `border-2 spinner` + "分析中" 文案。
    - 未分析: 显示刷新 svg + "重新分析"。
    - `disabled={isCurrentlyAnalyzing}`,`title="重新分析当前分集剧本"`。
  - `hasAnalysis && onNavigateNext` 时显示 "进入资产设定" 按钮 `variant="primary"` + 右箭头 svg(行 280-285)。
- **[VIS-CK]**: 按钮对齐 / spinner 颜色(`var(--action)` 蓝)/ 按钮间距 `gap-2`。

### A3. 只读提示条(isReview)
- `isReview === true` 时显示(行 290-295):
  - `bg-[var(--bg-hover)]` 灰底 + `text-[var(--text-3)]` 弱化色 + 12px 小字。
  - 含信息 svg + "只读模式 — 此阶段已过,仅可查看分析结果" 文案。
- app1 中 `isReview` 由父组件 EpisodeWorkspace 注入(批4 dramaforge 暂传 false,见 §5 defer)。
- **[VIS-CK]**: 灰底提示条圆角 / 图标对齐 / 文字垂直居中。

### A4. 分析增强提示词折叠卡
- 显示条件: `setAnalyzeEnhancementPrompt && !isReview`(行 298)— 即非只读 + 提供了 setter。
- 折叠头部(行 300-310):
  - 琥珀色星标 svg + "分析增强提示词" 标题 + 灰色说明 "指导角色/场景/资产提取方向(可选)"。
  - 右侧折叠箭头 svg,展开时 `rotate-180`(行 309)。
  - `hover:bg-[var(--bg-hover)]/40` 过渡色。
- 展开内容(行 311-360)双态:
  - **编辑态**(`enhancementEditing`): `<Textarea>` rows=3 autoFocus + placeholder 提示
    + "保存"(`variant="primary" size="sm"`) + "取消"(`variant="ghost" size="sm"`) 按钮(行 314-337)。
  - **查看态**: 灰底 `bg-[var(--bg-2)]` + 1px 边框的预览块(行 340-346):
    - 有 prompt: 显示 prompt 文本(`text-[var(--text)]`)。
    - 无 prompt: 显示 "点击「修改」添加增强提示词(可选)"(`text-[var(--text-3)]/50` 占位)。
    - `cursor-text` + 点击进入编辑态。
  - 查看态下方 "修改" + "清空" 按钮(行 347-356),清空时 `toast.info("已清空增强提示词")`。
- 保存回调: `setAnalyzeEnhancementPrompt(enhancementDraft)` + `toast.success("增强提示词已保存")` + 退出编辑。
- **[VIS-CK]**: 折叠展开动画 / Textarea 高度 / 按钮组对齐 / 预览块光标样式 / 占位文字颜色对比。

### A5. 分析中进度指示
- **app1 模式(双态)**(行 364-392):
  - `isCurrentlyAnalyzing && analyzeTaskId`: 渲染 `<GenerationProgress taskId label="AI 编剧分析中" estimatedDuration={90} onComplete={...} />` 异步跟踪(taskId 来自 POST /analyze 响应)。
  - `isCurrentlyAnalyzing && !analyzeTaskId`: 渲染 `<ProgressBar progress={0} label="AI 编剧分析中" stage="等待服务器返回任务 ID" pulse showPercent={false} />` + "该过程可能需要 1-2 分钟,请稍候" 副提示。
- onComplete 回调(行 371-377): `toast.success("分析完成,已提取场景与角色")` + `untrackTaskId(analyzeTaskId)` + 清 taskId + `onRefresh({ force: true })`。
- `isCurrentlyAnalyzing = episode?.status === "ANALYZING" || analyzing`(本地 state,行 158)。
- **[VIS-CK]**: ProgressBar pulse 动画 / 蓝色边框提示框 / 副提示文字间距。
- **注**: dramaforge 不走此模式,见 §4 翻译规则。

### A6. 空状态(EmptyState)
- 显示条件: `!hasAnalysis && !isCurrentlyAnalyzing`(行 395-404)。
- `<EmptyState>` props:
  - `icon`: 48×48 灰色场景结构 svg(行 397-399)。
  - `title="尚未进行编剧分析"`。
  - `description="请先在输入阶段保存剧本,然后点击「重新分析」按钮启动 AI 编剧分析"`。
  - `size="lg"`。
- **[VIS-CK]**: EmptyState 居中 / 大尺寸垂直留白 / 图标透明度。

### A7. 场景列表(核心展示)
- 显示条件: `hasAnalysis`(行 407-455)。
- 分组标题(行 409-415): h3 含琥珀色竖条 `w-1 h-4 bg-[var(--accent)] rounded-full` + "场景列表" + 灰色计数 `(N)`。
- 每个场景卡(`sortedScenes.map`,行 416-453):
  - 容器: `card p-4 animate-fade-in` + 阶梯延迟 `animationDelay: ${i * 30}ms`(行 424)。
  - 左侧序号徽章: `w-8 h-8 rounded-lg bg-[var(--accent-dim)]` + 琥珀色 `String(i+1).padStart(2,"0")`(行 426-428)。
  - 右侧内容(行 429-450):
    - 第一行 `flex flex-wrap gap-2`: sceneId(`font-mono text-xs text-[var(--text-3)]`)+ 地点 badge `badge-accent` + 时间 badge `badge-muted` + 内外景 badge `badge-muted`(行 430-435)。
    - 第二行(若有 characters): "出场角色" uppercase tracking-wider 小标签 + 角色 chips(行 436-445)。
      - chip 样式: `px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[10px] text-[var(--text-2)] border border-[var(--border-light)]`。
    - 场景正文 `<p>` `text-sm text-[var(--text-2)] leading-relaxed whitespace-pre-wrap break-words`(行 446-448),空内容显示 "（无内容）"。
- `sortedScenes` 是 `scenes` 浅拷贝(行 213-215,预留排序扩展位)。
- `allCharacters` 是 `scenes.characters` 去重并集(行 217-224,供标题区计数)。
- **[VIS-CK]**: 序号徽章圆角/颜色 / badge 三种变体对比 / chip 边框 / 正文换行保留 / 卡片入场动画。

### A8. 信息点(2 列网格)
- 显示条件: `hasAnalysis && infoPoints.length > 0`(行 458-480)。
- 分组标题(同 A7 风格): "信息点 (N)"。
- 网格: `grid grid-cols-1 sm:grid-cols-2 gap-2`(行 465)。
- 每张卡(行 466-477):
  - 标题: `text-xs font-semibold text-[var(--text)]`(取 `p.title || `信息点 ${i+1}``)。
  - 描述(若有): `text-xs text-[var(--text-3)] leading-relaxed whitespace-pre-wrap`。
- 数据来源: `episode.scriptData.infoPoints[]`,每项 `{ title?, content?, ... }`(行 62-67)。
- **[VIS-CK]**: 双列响应式断点 / 卡片标题字重 / 描述换行。

### A9. 造型表(table rowSpan)
- 显示条件: `hasAnalysis && costumeSceneKeys.length > 0`(行 483-527)。
- 分组标题: "造型表 (N 场景)"。
- 容器: `card overflow-hidden` 内嵌 `overflow-x-auto`(行 490-491)。
- 表头(行 493-499): `bg-[var(--bg-hover)]` + 三列 "场景" / "角色" / "造型"。
- 表体(行 500-521): `costumeSceneKeys.flatMap` 遍历,每个 sceneKey 下:
  - 若 `charKeys.length === 0`: 单行 `<tr>` + sceneKey(琥珀色 font-medium) + `<td colSpan={2}>—</td>`(行 505-510)。
  - 否则: 每个 charName 一行,首行 `<td rowSpan={charKeys.length}>` 显示 sceneKey,后续行省略 sceneKey 单元格(行 512-520)。
    - 角色列: `text-[var(--text-2)] align-top`。
    - 造型列: `text-[var(--text-2)] leading-relaxed`。
- 数据来源: `episode.scriptData.costumeMap` 类型 `Record<string, Record<string, string>>`(行 80-81)。
- **[VIS-CK]**: rowSpan 渲染正确性 / 横向滚动条 / 表头底色 / 边框 `border-[var(--border-light)]`。

### A10. 原始分析折叠(details/summary)
- 显示条件: `hasAnalysis && scriptData?.rawAnalysis`(行 530-543)。
- `<details className="card overflow-hidden">` 原生折叠组件。
- `<summary>`(行 533-537): 下箭头 svg + "原始分析文本" + 灰色字符数 `(N 字符)` + `cursor-pointer` + hover 过渡色。
- 内容 `<pre>`(行 538-540): `text-xs text-[var(--text-3)] whitespace-pre-wrap break-words font-mono leading-relaxed max-h-80 overflow-y-auto`。
- 数据来源: `episode.scriptData.rawAnalysis`(AI 原始返回文本,parseScriptResult 之前的完整输出)。
- **[VIS-CK]**: details 展开/折叠箭头旋转 / pre 字体等宽 / max-h-80 滚动条 / 字符数动态显示。

### A11. 底部操作(进入资产设定重复按钮)
- 显示条件: `hasAnalysis && onNavigateNext && !isReview`(行 546-553)。
- `mt-6 pt-4 border-t border-[var(--border-light)]` + `flex justify-end`。
- 重复渲染 "进入资产设定" primary 按钮(与 A2 顶部按钮一致),供用户滚到底部后直接进入下一阶段。
- **[VIS-CK]**: 顶部分隔线 / 右对齐 / 按钮与 A2 视觉一致。

---

## 2. dramaforge 现状 gap

### 2.1 前端 gap(EpisodeWorkspace analyzing 内联)
位置: `D:\dramaforge-cs\packages\web\app\workspace\[projectId]\components\EpisodeWorkspace.tsx` 行 655-718(约 63 行)。
handler 位置: 行 391-418 `handleReanalyze`。

| 功能 | app1 | dramaforge 现状(行 655-718) | gap |
|------|------|----------------------|-----|
| 标题区 | h2 + 琥珀图标 + 场景数/角色数/模型/时间 | 仅 `text-base` "场景结构（N 场）" | **缺** 图标/角色数/模型/时间 |
| 顶部操作 | "按实际 Token 结算" + 重新分析 + 进入资产设定 | 仅 "重新分析" `variant="ghost" size="sm"` | **缺** Token 提示 / 进入资产设定按钮 |
| 只读提示条 | isReview 灰底提示 | 无 | **缺**(可 defer,见 §5) |
| 增强提示词卡 | 完整折叠卡 + 编辑/查看双态 | 无 | **全缺** |
| 分析中进度 | GenerationProgress / ProgressBar 双态 | `Spinner` + 一行文字 | **缺** ProgressBar 模式 |
| 空状态 | EmptyState lg | `<p>` + "去输入剧本" 链接 | **缺** EmptyState 组件 |
| 场景列表 | 序号琥珀徽章 + mono sceneId + 三 badge + 角色 chips + content | 序号 + `location · time · intExt` 拼接 + 角色 inline + content | **缺** 徽章 / badge 视觉 / chips |
| 信息点 | 2 列网格 | 无 | **全缺** |
| 造型表 | table rowSpan | 无 | **全缺** |
| 原始分析折叠 | details/pre mono | 无 | **全缺** |
| 底部操作 | 进入资产设定按钮 | 无(靠全局 nextStage 按钮替代) | **缺** |

### 2.2 后端 route gap
位置: `D:\dramaforge-cs\packages\web\app\api\projects\[id]\episodes\[episodeId]\analyze\route.ts`(209 行)。

| 字段/能力 | app1 route(964 行) | dramaforge route(209 行) | 状态 |
|----------|-------------------|-------------------|------|
| `enhancementPrompt` 接收 | ✓(行 313-321) | ✓(行 94-97) | **已就绪** |
| `analyzedAt` 写入 scriptData | ✓(`new Date().toISOString()`,行 467) | ❌(scriptData 无此字段,行 159-168) | **小 gap,1 行补** |
| `modelUsed` 写入 scriptData | ✓(行 466) | ✓(行 167) | **已就绪** |
| `localizationProfile` 接收/写回 | ✓(行 322-328, 464) | 部分(只在 episode.scriptData 读,route body 不接收) | **小 gap**(可 defer) |
| 跨集 previousEpisodes 注入 | ✓(行 357-407,查询前集完整剧本 + 已有资产) | ❌(只传 episodeNumber,未注入 previousEpisodes) | **大 gap,defer 到 T2b** |
| 资产提取第二步(buildAssetExtractionPrompt → assets 表) | ✓(行 520-633) | ❌(完全未实现) | **大 gap,defer 到批5 assets** |
| 计费 precheck/debit | ✓(行 410, 442, 612) | ❌ | **defer 到批9** |
| taskId 异步返回(BullMQ STORY_ANALYZE) | ❌(app1 也是 route 同步直连) | ❌(同步直连) | **无 gap** |

**结论**: 批4 后端**无关键 gap**,只需补 1 行 `analyzedAt` 字段(可选)。所有大 gap(跨集/资产提取/计费)都属其他批范围,AnalyzingStage 前端不依赖。

### 2.3 dramaforge 已有可复用基础设施(批0/批2/批3)
- `components/ui/EmptyState.tsx`(批0): 支持 `icon/title/description/action/size`,与 app1 API 一致 — **直接 import**。
- `components/ui/ProgressBar.tsx`(批0): 支持 `progress/label/stage/pulse/completed/showPercent/variant` — **直接 import**。app1 的 `GenerationProgress` 在 dramaforge **不存在**(无 `components/features/` 目录),批4 用 ProgressBar 替代(对齐 InputStage 批3 已建立的模式)。
- `components/ui/Input.tsx`(批0): `Textarea` `forwardRef` + `rows/placeholder/value/onChange` 标准 props — **直接 import**。
- `components/ui/Button.tsx`(批0): `variant/size/loading/disabled` — **直接 import**。
- `components/ui/Toast.tsx`(批0): `useToast()` 返回 `{ info/success/error }` — **直接 import**。
- `hooks/useTaskStatus.ts`(批0): `trackTaskId/untrackTaskId/useTaskStatus` 已导出(行 126-137, 387)。批4 AnalyzingStage **不使用**(同步直连模式),保留导出供其他批用。
- `lib/stage-config.ts`(批2): `STAGES/stageOrder/deriveStageFromEpisode/StageKey` — AnalyzingStage 通过 `onNavigateNext` 间接消费(由 EpisodeWorkspace 注入)。
- `lib/api.ts`(批2 C): useApi + envelope 解析,通过 page.tsx → EpisodeWorkspace 透传 `api` prop。
- `app/workspace/[projectId]/components/InputStage.tsx`(批3): **模式参考** — 已建立"同步直连 + ProgressBar 多阶段等待"模式(行 318-342),AnalyzingStage 重新分析照搬此模式。

---

## 3. 实现步骤

### Step 1. 新建 `packages/web/app/workspace/[projectId]/components/AnalyzingStage.tsx`
镜像 app1 `AnalyzingStage.tsx`(556 行)完整结构,移植 A1-A11 共 11 个功能,适配点(见 §4):
- **删** `import { GenerationProgress } from "@/components/features"`(dramaforge 无此组件)。
- **删** `import { trackTaskId, untrackTaskId } from "@/hooks/useTaskStatus"`(同步直连,不用)。
- **改** A5 进度指示:删 `analyzeTaskId` state + 双态分支,改为单一 `ProgressBar` `pulse` 模式(对齐 InputStage 批3 行 623-639)。
- **改** `handleReanalyze`:删 `if (d && d.taskId) {...}` 分支,只保留同步返回分支(POST /analyze 等待 `{ episode, scriptData }` 后 `onRefresh({ force: true })`)。
- **保留** `isReview` prop 接口(但 §4 翻译规则: EpisodeWorkspace 暂传 false)。
- **保留** `analyzeEnhancementPrompt` + `setAnalyzeEnhancementPrompt` props 接口(由 EpisodeWorkspace 内部 state + localStorage 持久化,见 Step 2)。
- **保留** 全部 11 个 UI 区块 + CSS 变量 + Tailwind 类名(对齐 app1 视觉)。
- **保留** Props 类型定义 `AnalyzingStageProps`(行 103-127),`EpisodeInfo`/`ScriptScene`/`InfoPoint`/`SceneMeta`/`CostumeMap` 接口(行 51-101)。

文件位置: `D:\dramaforge-cs\packages\web\app\workspace\[projectId]\components\AnalyzingStage.tsx`(与 InputStage.tsx 同目录)。
预估行数: ~480 行(去掉 GenerationProgress 双态 + taskId 逻辑约 -70 行)。

### Step 2. 改 `packages/web/app/workspace/[projectId]/components/EpisodeWorkspace.tsx`
- **删** 行 391-418 `handleReanalyze`(逻辑移入 AnalyzingStage 内部)。
- **删** 行 237 `analyzing` state(仅内联 handler 用,AnalyzingStage 内部自管)。
- **删** 行 655-718 analyzing 阶段内联 `<section>` 块,替换为:
  ```tsx
  {viewStage === "analyzing" && (
    <AnalyzingStage
      projectId={projectId}
      episodeId={episodeId}
      episode={episode}
      category={project?.category ?? "DOMESTIC"}
      api={api as (url: string, options?: RequestInit) => Promise<any>}
      onRefresh={(opts) => {
        void loadEpisode();
        if (opts?.force) void loadProjectAssets();
      }}
      onNavigateNext={() => syncStageView("assets")}
      analyzeEnhancementPrompt={analyzeEnhancementPrompt}
      setAnalyzeEnhancementPrompt={setAnalyzeEnhancementPrompt}
      scriptModel={scriptModel}
      isReview={false}
    />
  )}
  ```
- **加** `analyzeEnhancementPrompt` state + localStorage 持久化(对齐 app1 page.tsx:159-165):
  ```tsx
  const [analyzeEnhancementPrompt, setAnalyzeEnhancementPrompt] = React.useState(() => {
    if (typeof window === "undefined") return "";
    try { return localStorage.getItem(`analyzeEnhance_${projectId}`) || ""; } catch { return ""; }
  });
  React.useEffect(() => {
    try { localStorage.setItem(`analyzeEnhance_${projectId}`, analyzeEnhancementPrompt); } catch {}
  }, [projectId, analyzeEnhancementPrompt]);
  ```
- **加** `import { AnalyzingStage } from "./AnalyzingStage";` 顶部。
- 保留 `scriptData` / `scenes` 等其他阶段也要用的 state(Storyboard 阶段行 750-806 也读 scenes)。

### Step 3. 后端 route gap(可选,1 行补丁)
位置: `packages/web/app/api/projects/[id]/episodes/[episodeId]/analyze/route.ts` 行 159-168。
- 在 `scriptData` 对象中追加 `analyzedAt: new Date().toISOString()`(对齐 app1 route.ts:467)。
- **影响**: AnalyzingStage A1 副标题时间显示;旧 episode 无此字段时 UI 已优雅降级(行 247 `scriptData?.analyzedAt &&` 守卫)。
- **风险**: 零(纯 JSONB 字段追加,无 schema 变更,GC-5 无冲突)。
- **建议默认**: 补(1 行,对齐 app1)。

### Step 4. 视觉检查(强制,CLAUDE.md)
1. 启动 dev server,导航到 `/workspace/{projectId}/episodes/{episodeId}?stage=analyzing`。
2. 用 `browser-harness` 截图:
   - `new_tab(url)` → `wait_for_load()` → `time.sleep(2)` → `capture_screenshot` 全页。
   - 滚动到场景列表中部 / 造型表 / 原始分析折叠,各截 1 张(共 3-4 张)。
3. 每张用 vision skill 分析:
   ```
   python ~/.claude/skills/vision/vision.py "截图路径" "分析布局问题:对齐/间距/溢出/留白/截断/空白区域等,重点核查场景序号徽章/角色 chips/造型表 rowSpan/原始分析滚动条"
   ```
4. 输出乱码用 GBK 解码: `open(path, 'rb').read().decode('gbk')`。
5. 汇总问题清单,逐条修复后重新截图验证。

测试数据准备: 用一个有完整分析结果的 episode(若无可临时 POST /analyze 一次产生 scriptData,确保 scenes/infoPoints/costumeMap/rawAnalysis 全字段非空)。

---

## 4. 翻译规则(每条 app1 功能 → dramaforge 处理,引用 GC)

| app1 功能 | dramaforge 处理 | GC 引用 |
|----------|----------|---------|
| A1 标题区 modelUsed/analyzedAt 显示 | 镜像;analyzedAt 需 Step 3 后端补 1 行 | GC-3(只读 app1) |
| A2 顶部"按实际 Token 结算"提示 | 镜像(纯文本,无 key 暴露) | GC-1(BYOK 禁,key 云端) |
| A2 重新分析按钮 POST /analyze | 镜像;body 仅 `{ model, enhancementPrompt }`,无 key 字段 | GC-1 + dramaforge-keys-cloud-server-only |
| A3 isReview 只读提示条 | 保留 prop,EpisodeWorkspace 暂传 false(defer 批9) | GC-6(行为等价,接口保留) |
| A4 增强提示词卡 | 镜像;state 由 EpisodeWorkspace 持有 + localStorage(`analyzeEnhance_${projectId}`) | GC-3 + dramaforge-frontend-align-app1 |
| A5 GenerationProgress(taskId 异步跟踪) | **替换** 为 ProgressBar pulse 模式(dramaforge analyze route 同步直连,不返回 taskId);对齐 InputStage 批3 已建立模式 | GC-7(架构差异,行为等价:都向用户反馈"分析中") |
| A5 `trackTaskId/untrackTaskId` | **删除**(同步直连不需要) | GC-7 |
| A6 EmptyState | 镜像;复用批0 `@/components/ui/EmptyState` | prefer-better-lib-not-selfbuilt |
| A7 场景列表 | 镜像;纯文本/JSON 数据展示,无媒体字节 | dramaforge-assets-client-local(无冲突) |
| A8 信息点 | 镜像;纯文本展示 | 同上 |
| A9 造型表 | 镜像;纯文本 table | 同上 |
| A10 原始分析折叠 | 镜像;纯文本 pre | 同上 |
| A11 底部进入资产设定按钮 | 镜像;`onNavigateNext` 由 EpisodeWorkspace 注入 `syncStageView("assets")` | GC-6 |
| analyze route 资产提取第二步 | **defer** 到批5 assets(AnalyzingStage 前端不依赖,只展示 scriptData) | GC-5(无新 .sql) |
| analyze route 跨集 previousEpisodes | **defer** 到 T2b(AnalyzingStage 不依赖) | GC-7 |
| analyze route 计费 | **defer** 到批9 | GC-1 |

**核心架构翻译**: app1 的 analyze route 是同步直连(行 414-428 `gateway.request` 等待返回),app1 前端 AnalyzingStage 却用 GenerationProgress taskId 模式 — 这是 app1 历史遗留的双轨(部分 route 返回 taskId 部分返回完整结果,见 app1 AnalyzingStage 行 182-193 双分支)。dramaforge 批4 直接走同步分支(POST /analyze 等待 `{ episode, scriptData }`),用 ProgressBar pulse 反馈"分析中"状态,与 InputStage 批3 模式一致 — **行为等价,无功能损失**。

---

## 5. 风险 + defer 项

### 5.1 批4 必做(无 defer)
- A1-A4 / A6-A11 共 10 个 UI 区块完整镜像。
- A5 用 ProgressBar 替换 GenerationProgress(行为等价)。
- EpisodeWorkspace 接入 AnalyzingStage(替内联 + 加 analyzeEnhancementPrompt state)。
- 后端 Step 3 补 analyzedAt(1 行)。

### 5.2 defer 项(批4 不做)
| 功能 | defer 到 | 理由 |
|------|---------|------|
| **isReview 只读模式** | 批9(只读回顾) | dramaforge 当前所有阶段均无 isReview 概念;批9 统一加 review/只读模式时再补全所有阶段 |
| **GenerationProgress taskId 跟踪** | 永久 defer | dramaforge analyze route 同步直连,根本不返回 taskId;若未来切异步 BullMQ 再说 |
| **跨集 previousEpisodes 注入** | T2b(跨集上下文补丁) | 后端 route 大改(查询前集 + 已有资产),前端无影响;app1 route.ts:357-407 |
| **资产提取第二步** | 批5 assets | 后端 route 写 assets 表大块(app1 route.ts:520-633),属资产阶段范畴;AnalyzingStage 不直接消费 assets |
| **localizationProfile route body 接收** | 批4 顺手 / 批5 | 当前只在 episode.scriptData 读;若 InputStage 已写 scriptData.localizationProfile 则 route 已能读到。可选补 route body 解析(对齐 app1 route.ts:322-328) |
| **计费 precheck/debit** | 批9 | app1 route.ts:410/442/612;dramaforge callAI 返回无 cost 字段,待按 tokensUsed 计费 |

### 5.3 风险
1. **handleReanalyze 双重实现**: 当前 EpisodeWorkspace 行 391-418 已有 `handleReanalyze`,Step 2 必须删除避免双份逻辑。新 AnalyzingStage 内部 handler 行为需与 InputStage 一致(InputStage 已保存 novelText,AnalyzingStage 只 POST analyze,不 PATCH novelText)。
2. **episode state 更新时序**: AnalyzingStage 重新分析成功后通过 `onRefresh({ force: true })` 让 EpisodeWorkspace 重新拉数据。EpisodeWorkspace `loadEpisode` 已就绪(行 260-288),沿用即可。注意 `loadRequestSeqRef` 防过期覆盖机制(行 254)。
3. **localStorage key 命名**: 直接照搬 app1 `analyzeEnhance_${projectId}`。dramaforge projectId 是 prisma cuid,与 app1 格式不同但 key 不会冲突(同浏览器不同部署域名隔离)。若用户在 dramaforge 与 app1 同浏览器切换,localStorage 不互通(因 projectId 不同),无风险。
4. **场景列表 sortedScenes 排序**: app1 行 213-215 预留排序扩展位但当前只是浅拷贝。dramaforge 直接照搬,未来若需按 sceneId 排序再补。
5. **costumeMap 数据 shape**: app1 前端类型是 `Record<string, Record<string, string>>`(行 81),但 app1 后端 `parseScriptResult` 返回的是 `CostumeMapEntry[]`(数组,见 script-prompt.ts:1145)。**app1 route.ts 在写 scriptData 时直接写了 `costumeMap: parsed.costumeMap`(行 463),所以 scriptData.costumeMap 实际是数组而非 Record**。dramaforge route.ts 行 165 同样写 `costumeMap: parsedScript.costumeMap` — 也是数组。这意味着 **app1 AnalyzingStage A9 造型表 `Object.keys(costumeMap)` + `costumeMap[sceneKey]` 在运行时是错的**(Object.keys 对数组返回索引字符串)。**需核查 app1 实际运行时是否走到了 A9**(可能 app1 UI 实际从未渲染造型表,或后端有其他转换)。**建议默认**: 批4 实现时先按 app1 原样镜像(Record 类型),若实测数据 shape 是数组则在 AnalyzingStage 内做兼容转换(数组 → Record,GC-7 行为等价)。**开放问题 Q1**。

---

## 6. 优化点(实现层,行为不变)

> 红线: 本节优化只针对"实现质量"(结构/性能/可读性/重复代码/类型严谨),**不改变业务结果/行为**。
> 若某优化会让业务行为偏离 app1,标"⚠️ 需 coordinator 定",实现 agent 不自作主张改。

迁移为主但**不是死板照搬 app1**。app1 AnalyzingStage 有若干设计欠佳处,dramaforge 迁移时顺势改好(行为等价)。

### OP1. `costumeMap` 类型与运行时 shape 不一致(app1 真 bug)⚠️ 需 coordinator 定优先级
- **app1 问题**: 前端类型声明 `type CostumeMap = Record<string, Record<string, string>>`(行 81),A9 造型表用 `Object.keys(costumeMap)` + `costumeMap[sceneKey][charName]`。但后端 `parseScriptResult` 返回 `CostumeMapEntry[]`(数组,script-prompt.ts:1145),且 route.ts:463 直接写 `costumeMap: parsed.costumeMap`。运行时 `Object.keys(数组)` 返回 `["0","1","2"...]` 索引字符串,`costumeMap["0"][charName]` 是 `undefined` → **app1 A9 造型表实际渲染错乱或不渲染**。
- **dramaforge 优化方向**: 直接用 `CostumeMapEntry[]` 类型(import from `@dramaforge/server/prompt` type-only),重写 A9 渲染:
  ```ts
  // 按 sceneId 分组,组内遍历角色
  const costumeGroups = React.useMemo(() => {
    const raw = scriptData?.costumeMap;
    if (!Array.isArray(raw)) return [] as Array<{ sceneId: string; rows: CostumeMapEntry[] }>;
    const m = new Map<string, CostumeMapEntry[]>();
    for (const e of raw as CostumeMapEntry[]) {
      if (!m.has(e.sceneId)) m.set(e.sceneId, []);
      m.get(e.sceneId)!.push(e);
    }
    return Array.from(m.entries()).map(([sceneId, rows]) => ({ sceneId, rows }));
  }, [scriptData?.costumeMap]);
  // 渲染: costumeGroups.flatMap(g => g.rows.map((entry, idx) => <tr>...))
  //   idx===0 时 <td rowSpan={g.rows.length}>{g.sceneId}</td>
  //   每个 entry: <td>{entry.character}</td><td>{entry.costumeLabel} / {entry.costumeDesc}{entry.isNew ? " / 新造型" : ""}</td>
  ```
- **行为对比**: app1 造型表实际渲染失败(数据 shape 错);dramaforge 修正后造型表能正常渲染。**严格说这改变了"业务结果"**(app1 用户看不到造型表,dramaforge 用户能看到)— 但 app1 本意是展示造型表(代码意图明确),只是 bug 导致没渲染。**标 ⚠️**: 建议默认修复(对齐 app1 设计意图,不是对齐 app1 bug 行为),但 coordinator 可选 defer(若担心 batch5 assets 才需要造型表)。
- **关联**: §5.3 风险 5 + §8 Q1。

### OP2. 死代码: `sortedScenes` 浅拷贝无排序
- **app1 问题**: 行 213-215 `const sortedScenes = React.useMemo(() => [...scenes], [scenes]);` — 没有任何排序逻辑,完全等价于直接用 `scenes`。预留排序扩展位但从未扩展。
- **dramaforge 优化**: 删除 `sortedScenes`,A7 场景列表直接 `scenes.map(...)`。
- **行为**: 不变(渲染顺序一致)。

### OP3. 死代码: 空 `useEffect`
- **app1 问题**: 行 201-204 `React.useEffect(() => { if (!analyzeTaskId || !isCurrentlyAnalyzing) return; // GenerationProgress onComplete 触发刷新 }, [analyzeTaskId, isCurrentlyAnalyzing])` — effect body 是空的,注释说"GenerationProgress onComplete 触发刷新"但啥都没做。
- **dramaforge 优化**: 删除整个 effect(同步直连模式连 `analyzeTaskId` state 都不需要,见 OP4)。
- **行为**: 不变(空 effect 本就无作用)。

### OP4. 死代码: `taskId` 异步分支 + `analyzeTaskId` state
- **app1 问题**: `handleReanalyze` 行 182-193 处理 `d.taskId`(异步)和 `d.episode`(同步)两路,但 app1 route 实际只返回同步 `{ episode, scriptData }`(route.ts:946-959 无 taskId 字段)。`analyzeTaskId` state + `trackTaskId`/`untrackTaskId` 调用全是死代码。
- **dramaforge 优化**: 同步直连模式,删 `analyzeTaskId` state + `trackTaskId`/`untrackId` import + `useEffect` 清理 + `handleReanalyze` 内 `taskId` 分支。只保留同步分支: `await api(POST /analyze)` → `onRefresh({ force: true })` → `setAnalyzing(false)`。
- **行为**: 不变(app1 实际就走这路)。
- **关联**: §4 翻译规则 A5。

### OP5. 重复"进入资产设定"按钮
- **app1 问题**: A2(行 280-285)和 A11(行 546-553)渲染同一按钮,代码重复 ~7 行(svg + 文案 + variant)。
- **dramaforge 优化**: 抽局部组件或 const:
  ```tsx
  const NavigateToAssetsButton = (
    <Button variant="primary" onClick={onNavigateNext}>
      进入资产设定
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12h14m0 0l-6-6m6 6l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
    </Button>
  );
  // A2 和 A11 都渲染 {NavigateToAssetsButton}
  ```
- **行为**: 不变。

### OP6. 类型散落 + `any` 泄漏
- **app1 问题**: `EpisodeInfo`/`ScriptScene`/`InfoPoint`/`SceneMeta`/`CostumeMap` 在 AnalyzingStage 内部重复定义(行 51-101),且 `api` prop 类型是 `Promise<any>`(行 113)。与 InputStage/EpisodeWorkspace 的 `EpisodeRecord` 类型不兼容,props 传递时类型不严。
- **dramaforge 优化**:
  - 复用 `EpisodeRecord`(from `@dramaforge/shared`,批2 已就绪)替代内部 `EpisodeInfo`。
  - 复用 `ScriptScene`/`InfoPoint`/`SceneMeta`/`CostumeMapEntry`(from `@dramaforge/server/prompt` type-only,批3 barrel 已导出)。
  - `api` prop 类型用 dramaforge `lib/api.ts` 的 envelope-aware 类型(若已存在)或保留 `(url: string, options?: RequestInit) => Promise<unknown>` + 调用处 narrow。
- **行为**: 不变(纯类型收紧)。
- **关联**: §7.1 批0/批2 已有类型。

### OP7. `scriptData` 字段访问无 runtime narrow
- **app1 问题**: 行 155-157 `const scenes = scriptData?.scenes ?? [];` / `infoPoints` / `costumeMap` 直接访问,假设 shape 正确。但 `EpisodeRecord.scriptData` 是 `unknown`(DB JSONB 透传,见 EpisodeWorkspace.tsx:256 `scriptData as ScriptData | null | undefined`)。恶意/异常数据会导致渲染崩溃。
- **dramaforge 优化**: 加 narrow helper(对齐 InputStage 批3 `readLocalizationProfile` 模式,InputStage.tsx:106-126):
  ```ts
  function readScriptData(scriptData: unknown): {
    scenes: ScriptScene[];
    infoPoints: InfoPoint[];
    costumeMap: CostumeMapEntry[];
    rawAnalysis?: string;
    modelUsed?: string;
    analyzedAt?: string;
  } {
    if (!scriptData || typeof scriptData !== "object" || Array.isArray(scriptData)) {
      return { scenes: [], infoPoints: [], costumeMap: [] };
    }
    const s = scriptData as Record<string, unknown>;
    return {
      scenes: Array.isArray(s.scenes) ? s.scenes as ScriptScene[] : [],
      infoPoints: Array.isArray(s.infoPoints) ? s.infoPoints as InfoPoint[] : [],
      costumeMap: Array.isArray(s.costumeMap) ? s.costumeMap as CostumeMapEntry[] : [],
      rawAnalysis: typeof s.rawAnalysis === "string" ? s.rawAnalysis : undefined,
      modelUsed: typeof s.modelUsed === "string" ? s.modelUsed : undefined,
      analyzedAt: typeof s.analyzedAt === "string" ? s.analyzedAt : undefined,
    };
  }
  ```
- **行为**: 不变(异常数据下优雅降级而非崩溃;正常数据下渲染一致)。

### OP8. 折叠模式不一致
- **app1 问题**: A4 增强提示词卡(行 300)用受控 state + `<button onClick={setEnhancementCollapsed}>`,A10 原始分析(行 532)用原生 `<details>`/`<summary>`。两种折叠模式并存,风格不统一。
- **dramaforge 优化**: 统一为受控 state + `<button>`(因 A4 已需要受控以联动编辑态;A10 统一后更一致,且可加 `aria-expanded`)。或反向都用 `<details>` 但 A4 编辑态需额外处理。**建议默认**: 统一受控。
- **行为**: 不变(折叠/展开视觉效果一致)。

### OP9. `!isReview` 守卫散落
- **app1 问题**: `!isReview` 在 4 处重复判断(A2 行 255 + 260,A4 行 298,A11 行 546)。
- **dramaforge 优化**: 抽 `const canEdit = !isReview;` 单变量,4 处替换。
- **行为**: 不变。

### OP10. `costumeSceneKeys` / `allCharacters` 非 memoized 或可简化
- **app1 问题**:
  - `costumeSceneKeys = Object.keys(costumeMap)`(行 227)每次渲染重算。
  - `allCharacters`(行 217-224)用 `Set` + 嵌套循环。
- **dramaforge 优化**:
  - 若 OP1 采纳(costumeMap 改为 `CostumeMapEntry[]`),则 `costumeSceneKeys` 改为 `costumeGroups`(见 OP1 代码)用 `React.useMemo`。
  - `allCharacters` 简化为 `React.useMemo(() => Array.from(new Set(scenes.flatMap(s => s.characters ?? []))), [scenes])`。
- **行为**: 不变。

### OP11. 无障碍属性缺失
- **app1 问题**: 折叠 button 无 `aria-expanded`/`aria-controls`,svg 无 `aria-hidden`,EmptyState 无 `role="status"`。
- **dramaforge 优化**: 补 a11y 属性(`aria-expanded={...}` / `aria-controls="id"` / `aria-hidden="true"` on decorative svg)。
- **行为**: 不变(纯 a11y 增强,屏幕阅读器体验提升)。

### OP12. `isCurrentlyAnalyzing` 双源
- **app1 问题**: 行 158 `const isCurrentlyAnalyzing = episode?.status === "ANALYZING" || analyzing;` — 后端 status + 本地 state 双源,可能不同步(route 同步返回后 status 已是 COMPLETED 但本地 `analyzing` 还是 true 短暂窗口)。
- **dramaforge 优化**: 同步直连模式下,本地 `analyzing` state 足够(`const isCurrentlyAnalyzing = analyzing`)。`episode.status === "ANALYZING"` 在同步模式下永远不会被 UI 看到(route 在响应前就 update 到 COMPLETED 了)。
- **行为**: 不变(同步模式下 `episode.status === "ANALYZING"` 窗口为零)。

### ⚠️ 需 coordinator 定(行为可能偏离 app1,不自动改)

#### OP13. `enhancementDraft` 编辑态切 stage 丢失
- **app1 行为**: 用户在 A4 增强提示词卡编辑一半(draft 已改但未点"保存")切到其他 stage,draft 丢失(本地 state,卸载即清)。
- **dramaforge 可优化**: 把 draft 持久化到 localStorage,或切 stage 前 warn 用户"有未保存的增强提示词"。
- **⚠️ 改变行为**: app1 不 warn,优化后 warn → 偏离 app1。**建议默认**: 不改(对齐 app1),coordinator 可选优化。

#### OP14. 重新分析 vs InputStage 保存分析的逻辑去重
- **app1 现状**: InputStage "保存并分析"按钮和 AnalyzingStage "重新分析"按钮都 POST /analyze,但 InputStage 还 PATCH novelText,AnalyzingStage 只 POST analyze(假设 novelText 已存)。
- **dramaforge 可优化**: 抽 `useAnalyze` hook 封装 POST /analyze 逻辑 + ProgressBar 状态,两处复用。
- **⚠️ 改变实现结构**: 抽 hook 改变代码组织,可能引入回归(InputStage 批3 已稳定)。**建议默认**: 不抽(批4 范围内 AnalyzingStage 独立实现,与 InputStage 逻辑各自维护),coordinator 可选优化(若担心重复)。

---

## 7. 依赖确认

### 7.1 批0(UI 库)— 全部就绪
- `@/components/ui/EmptyState` ✓(行 48-98,API 与 app1 一致)
- `@/components/ui/ProgressBar` ✓(行 44-159,支持 pulse/completed/stage/showPercent)
- `@/components/ui/Input` ✓(行 112,`Textarea` forwardRef)
- `@/components/ui/Button` ✓(variant/size/loading/disabled)
- `@/components/ui/Toast` ✓(`useToast()` 返回 info/success/error)

### 7.2 批2(EpisodeWorkspace/useApi/stage-config)— 全部就绪
- `EpisodeWorkspace` ✓ 接入点已存在(行 655 `viewStage === "analyzing"`),只需替换内联为 `<AnalyzingStage />`。
- `api` prop ✓ 由 page.tsx → EpisodeWorkspace 透传(批2 已装配 useApi + useEpisodeApiQueue)。
- `lib/stage-config.ts` ✓ STAGES/stageOrder/deriveStageFromEpisode/StageKey(行 24/56/66)。
- `loadEpisode` ✓(行 260-288)+ `loadProjectAssets` ✓(行 323-342,供 onRefresh force 时同步刷资产)。
- `syncStageView` ✓(行 153-160,供 onNavigateNext 切到 assets 阶段)。

### 7.3 批3(InputStage 模式参考)— 已就绪
- InputStage.tsx 行 318-342 已建立"同步直连 + ProgressBar 多阶段"模式,AnalyzingStage handleReanalyze 直接照搬此模式(简化为单阶段: "分析中" → 100%)。
- InputStage 已写入 `episode.scriptData.localizationProfile`(批3 行 304-311),dramaforge analyze route 通过 `episode.scriptData?.localizationProfile` 读取(无需 route body 接收,见 §2.2)。

### 7.4 后端 import(AnalyzingStage 不需要)
AnalyzingStage 是纯前端组件,不直接 import `@dramaforge/server`。所有数据通过 `episode.scriptData` JSONB 透传(由 route.ts 已写入)。

### 7.5 不需要的依赖(明确排除)
- `@/components/features/GenerationProgress` — dramaforge 不存在,用 ProgressBar 替代。
- `@/hooks/useTaskStatus` 的 `trackTaskId/untrackTaskId` — 同步直连模式不用。
- `@dramaforge/server` 任何 prompt 函数 — 前端不直接调 buildScriptAnalysisPrompt/parseScriptResult。

---

## 8. 开放问题(让 coordinator 定)

### Q1. costumeMap 数据 shape 兼容(见 §5.3 风险 5)
**背景**: app1 AnalyzingStage A9 造型表用 `Object.keys(costumeMap)` + `costumeMap[sceneKey][charName]`(Record 类型),但后端 `parseScriptResult` 返回 `CostumeMapEntry[]`(数组)。app1 route.ts:463 和 dramaforge route.ts:165 都直接写 `costumeMap: parsed.costumeMap`,所以 scriptData.costumeMap 实际是数组。
**建议默认**: 批4 实现时在 AnalyzingStage 内部做兼容转换(数组 → Record):
```ts
const costumeMap: Record<string, Record<string, string>> = React.useMemo(() => {
  const raw = scriptData?.costumeMap;
  if (!raw) return {};
  if (!Array.isArray(raw)) return raw as Record<string, Record<string, string>>;
  const map: Record<string, Record<string, string>> = {};
  for (const entry of raw as Array<{ sceneId: string; character: string; costumeLabel: string; costumeDesc: string; isNew: boolean }>) {
    if (!map[entry.sceneId]) map[entry.sceneId] = {};
    map[entry.sceneId][entry.character] = `${entry.costumeLabel} / ${entry.costumeDesc}${entry.isNew ? " / 新造型" : ""}`;
  }
  return map;
}, [scriptData?.costumeMap]);
```
**理由**: GC-7(行为等价,数据 shape 适配,UI 视觉不变)+ GC-3(不改 app1,只在 dramaforge 内部转换)。
**若 coordinator 不同意**: 直接照搬 app1 原样,若实测造型表为空则后续补丁。

### Q2. analyzedAt 后端补丁是否纳入批4
**背景**: §3 Step 3 提议补 1 行 `analyzedAt: new Date().toISOString()` 到 dramaforge analyze route.ts:159-168。
**建议默认**: 纳入批4(1 行,对齐 app1,零风险)。
**若 coordinator 不同意**: defer 到批5,AnalyzingStage A1 副标题时间显示暂空(UI 已有守卫优雅降级)。

### Q3. isReview prop 是否保留接口
**背景**: §4 翻译规则提议保留 `isReview` prop 接口但 EpisodeWorkspace 暂传 false(defer 批9)。
**建议默认**: 保留接口(为批9 review 模式预留,避免未来改 props 签名)。
**若 coordinator 不同意**: 批4 直接删 isReview 相关代码(A3 只读提示条 + A2/A11 !isReview 守卫),批9 再补。

---

## 9. 验收标准

- [ ] `D:\dramaforge-cs\packages\web\app\workspace\[projectId]\components\AnalyzingStage.tsx` 新建,~480 行,镜像 app1 11 个功能区块。
- [ ] `EpisodeWorkspace.tsx` analyzing 阶段内联块替换为 `<AnalyzingStage />`,删除 `handleReanalyze` + `analyzing` state,新增 `analyzeEnhancementPrompt` state + localStorage 持久化。
- [ ] `analyze/route.ts` 补 `analyzedAt` 字段(若 Q2 同意)。
- [ ] `npm run typecheck` 通过(packages/web)。
- [ ] `npm run build` 通过(packages/web,本地 `set -a && source .env && set +a`)。
- [ ] 视觉检查: 4 张截图(全页 + 场景列表中部 + 造型表 + 原始分析折叠)+ vision skill 分析报告,问题清单逐条修复。
- [ ] GC 自检: GC-1(无 key UI)/GC-3(app1 只读,未改)/GC-5(无新 .sql)/GC-6(行为等价)/GC-7(ProgressBar 替 GenerationProgress,行为等价)/GC-8(dramaforge 视觉对齐 app1)。

---

## 10. 参考文件清单(绝对路径)

### app1(只读参考,GC-3 不改)
- `F:\app1\src\app\workspace\[projectId]\components\AnalyzingStage.tsx`(556 行)— 镜像源
- `F:\app1\src\app\api\projects\[projectId]\episodes\[episodeId]\analyze\route.ts`(964 行)— 后端参考
- `F:\app1\src\app\workspace\[projectId]\page.tsx`(行 159-165)— analyzeEnhancementPrompt state 模式
- `F:\app1\src\app\workspace\[projectId]\components\EpisodeWorkspace.tsx`(行 800-810)— 父组件挂载参考
- `F:\app1\src\app\workspace\[projectId]\components\InputStage.tsx` — 同项目同风格参考

### dramaforge(可改)
- `D:\dramaforge-cs\packages\web\app\workspace\[projectId]\components\AnalyzingStage.tsx` — **新建**
- `D:\dramaforge-cs\packages\web\app\workspace\[projectId]\components\EpisodeWorkspace.tsx` — 改(替换内联 + 加 state)
- `D:\dramaforge-cs\packages\web\app\api\projects\[id]\episodes\[episodeId]\analyze\route.ts` — 改(补 analyzedAt,1 行)
- `D:\dramaforge-cs\packages\web\app\workspace\[projectId]\components\InputStage.tsx`(批3,模式参考,不改)
- `D:\dramaforge-cs\packages\web\components\ui\EmptyState.tsx`(批0,直接 import)
- `D:\dramaforge-cs\packages\web\components\ui\ProgressBar.tsx`(批0,直接 import)
- `D:\dramaforge-cs\packages\web\components\ui\Input.tsx`(批0,Textarea 直接 import)
- `D:\dramaforge-cs\packages\web\components\ui\Button.tsx`(批0,直接 import)
- `D:\dramaforge-cs\packages\web\components\ui\Toast.tsx`(批0,useToast 直接 import)
- `D:\dramaforge-cs\packages\web\lib\stage-config.ts`(批2,间接消费)
- `D:\dramaforge-cs\packages\server\src\domain\prompt\script-prompt.ts`(已就绪,parseScriptResult 输出 shape 参考)
- `D:\dramaforge-cs\packages\server\src\domain\prompt\index.ts`(批3 barrel,AnalyzingStage 不直接 import)

---

**Brief 结束**。Coordinator 确认 Q1/Q2/Q3 后,批4 实现可按 §3 Step 1-4 顺序执行。
