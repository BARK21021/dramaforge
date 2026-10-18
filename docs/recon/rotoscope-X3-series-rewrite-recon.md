# 转绘 X3 整剧重写主链 —— recon 计划（最重批次，~13-14 天）

> 续 2026-07-21 · 分支 feat/cs-ui-slice · 依赖 X1（gateway video_understanding + /api/generate/text）已通
> app1 只读（GC-3）。本文是 1 个深读 agent 读 app1 long-video-service.ts(1552) + long-video-prompt.ts(730) + OriginalRewriteStage + dramaforge 现状后的 **9-commit 实现计划**。

## A. app1 processLongVideo 全景

入口 `F:\app1\src\core\video\long-video-service.ts:517 processLongVideo`，触发于 original-video-upload/route.ts:118 createTask(LONG_VIDEO_REWRITE)。阶段：

1. **splitting(0-8%)** `splitVideoForKimi`（stream-copy 优先 -c copy -f segment，95MiB+ 或 webm/mkv 才回退 libx264）
2. **transcribing(10-55%)** 并发上传 Kimi `analyzeVideoSegment`（连续性锚点剧情事实稿）→ 拼接 sourceScript；>180k 字 → DeepSeek Flash 70k 分块并行 reduce
3. **outlining(55-74%)** DeepSeek `buildOutlinePrompt` + `[[GLOBAL_OUTLINE_COMPLETE]]` marker + finishReason=length 续写 → 结构门禁（≥50 集无缺）→ `inferTargetEpisodeCount` → 三段 `buildThreeStageEpisodeRanges` → canonicalDirectorBoard（全剧导演连续性板）→ authoritativeOutlineParts
4. **scripting(78-96%)** 3 段顺序（非并行）：`buildRewriteFromOutlinePrompt` + `[[RANGE_COMPLETE:start-end]]` + 续写 + appendOnlyMissingEpisodes + stalledParts≥2 break + 结构门禁 inspectScriptRangeStructure/inspectScriptSemanticDuplicates + 最多 3 次返修 + 段间冻结 stageDirectorBoard
5. **completed(100%)** 落 novelText/videoScriptDraft/status=SCREENWRITING/longVideoProgress.completed/scriptData.longVideoRewrite

断点：`workingDir/analysis-checkpoints/segment-NNN.json` + `generation-checkpoint.json`（fingerprint = sha256(projectId|size|duration|segCount|segDurationSec).slice(0,20)）。

## B. dramaforge 现状关键差距

- client orchestrator 197 行薄桩（仅 split→base64→HTTP→concat），需重写到 ~1500 行
- shared 缺：long-video-prompt(730) / long-video-utils(~20 纯函数) / language(detectLanguage) / long-video-concurrency(52)
- `/api/render/dispatch` 未含 LONG_VIDEO_REWRITE case；无 original-video-upload / progress / result 三 route
- workspace page.tsx 无 `category==="ORIGINAL"` 分流；无 OriginalRewriteStage
- ✅ 已有：Kimi video_understanding gateway（X1）+ DeepSeek text_generation gateway + dispatchLongVideoRewrite + DB longVideoProgress 列 + render-worker 30s heartbeat loop
- **splitVideoEvenly 总是 libx264 4Mbps 重编码** → 3GB 低码率会膨胀 5-10GB，必须换 stream-copy 优先

## C. 关键决策（已定）

1. **心跳**：render-worker loop.ts:280 的 30s setInterval 在 executeJob 整个期间持续刷 heartbeat_at → **天然覆盖 DeepSeek 15-30min 长调用**，orchestrator 不需自带心跳，只按阶段 report(progress,stage) 更新 UI。
2. **3GB 流式**：**不上真流式上传**（YAGNI）。靠 ① calculateKimiSegmentPlan 强制单段 ≤48MiB ② Kimi 上传并发限 4 ③ 每段读完即释放 buf。真流式 defer X4。
3. **字节落点**：3GB 视频落 Electron client 本地（userData/original-uploads/），orchestrator 本地 ffmpeg 切片；分段 base64 HTTP 上传到 server RAM 透传给 Kimi（server 不落盘）。需 Electron IPC 上传通道（X3.7），fallback 临时走 server tmpdir（标技术债）。
4. **DeepSeek 调用**：用现有 callAI('deepseek', text_generation)，需新 HTTP route（现有 /api/generate/text 写死 video_understanding）→ `/api/generate/long-video-text`，带余额熔断回退 kimi。
5. **checkpoint 目录**：用 Electron userData（非 os.tmpdir，防 OS 清理）。

## D. 9-commit 路线（每步独立可部署）

| commit | 内容 | 依赖 | 天数 |
|---|---|---|---|
| **X3.1** | shared 纯函数移植：language.ts(detectLanguage) + long-video-concurrency.ts(3 resolve) + long-video-prompt.ts(4 builder,730行) + long-video-utils.ts(~20 函数) + long-video-plan.ts 加 LongVideoProgress/Result 类型 + index.ts export | 无 | 1.5 |
| **X3.2** | render-job.ts LongVideoRewriteInput 扩展（projectId/userId/totalDurationSec/totalBytes/segmentSec/kimiModel/outlineModel/rewriteModel/sourceScriptOverride/checkpointDir + outputUploadUrl 改 optional） | X3.1 | 0.5 |
| **X3.3** | web `/api/generate/long-video-text` route（DeepSeek text_generation + 余额熔断回退 kimi + retryable 退避） | X3.1 | 1 |
| **X3.5** | client/ffmpeg `splitVideoForKimi`（stream-copy 优先，移植 app1 ffmpeg-pipeline.ts:505-597） | 无（可并行） | 1 |
| **X3.6a** | web `/api/projects/[id]/long-video-rewrite/progress` + `/result` route + `/api/projects/[id]` PATCH 扩白名单（novelText/videoScriptDraft） | X3.2 | 1.5 |
| **X3.6b** | `/api/render/dispatch` 加 LONG_VIDEO_REWRITE case + original-video-upload route | X3.6a | 1 |
| **X3.4** | **client orchestrator 完整重写 197→~1500 行**（逐阶段对齐 processLongVideo，复用 X1 /api/generate/text + X3.3 /api/generate/long-video-text + X3.5 splitVideoForKimi + X3.6 progress/result route） | X3.1/2/3/5/6a | 4-5（最重） |
| **X3.7** | OriginalRewriteStage UI（移植 207 行）+ page.tsx ORIGINAL 分流 + Electron preload IPC 上传通道 | X3.6 | 2 |
| **X3.8** | SSE/轮询进度展示 + 端到端 + 视觉检查 | X3.7 | 1.5 |

**关键路径**：X3.1 → X3.2 → (X3.3 ‖ X3.5 ‖ X3.6a) → X3.6b → X3.4 → X3.7 → X3.8

## E. 最大风险

1. **orchestrator 从未真跑**（197→1500）→ 生产首次只跑 30min/200MB 视频验主链再上 3GB
2. **DeepSeek 续写死循环** → 保留 stalledParts≥2 break + maxParts=16 + throw 保断点
3. **splitVideoEvenly 膨胀** → X3.5 stream-copy 优先
4. **结构门禁返修 3 次仍败** → 沿用 rewriteRepairDrafts 持久化，失败重启从 draft 续
5. **Electron IPC 上传延期** → fallback fetch PUT 落 server tmpdir（标债，X4 改）

## 文件索引

**app1 源（只读）**：`F:\app1\src\core\video\{long-video-service.ts(1552), long-video-prompt.ts(730), long-video-concurrency.ts(52), ffmpeg-pipeline.ts:505-597}` · `F:\app1\src\core\ai\language.ts:65-77` · `F:\app1\src\app\workspace\[projectId]\components\OriginalRewriteStage.tsx(207)` · `page.tsx:647-648` · `api/projects/[projectId]/original-video-upload/route.ts(178)`

**dramaforge 改**：shared 4 新文件 + render-job.ts + index.ts · client/orchestrators/long-video-rewrite.ts(重写) + client/ffmpeg/ffmpeg-pipeline.ts(加 splitVideoForKimi) · web 4 新 route（generate/long-video-text、long-video-rewrite/progress+result、original-video-upload）+ dispatch route + projects/[id] PATCH + OriginalRewriteStage.tsx + page.tsx
