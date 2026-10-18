# 转绘 / 长视频整剧重写 —— app1→dramaforge 差距与 X1-X4 计划（计划底册）

> 起草:2026-07-21(续47)· 分支 `feat/cs-ui-slice`
> 诉求:用户判定"海外转绘的功能要全部对齐干掉,不能砍了",选 **一把梭 X1→X4**。
> 本文是 1 个深挖 agent(读全 app1 video 子系统 + dramaforge 现状)+ 主链核对的结论,作为
> X1-X4 的计划底册与跨会话续命依据。app1 只读(GC-3)。

---

## 0. 核心认知纠偏:"转绘"在 app1 是两件事

1. **InputStage 视频转剧本 Tab** —— 单集 ≤100MB,DOMESTIC/OVERSEAS 用 → dramaforge 现在是 **disabled 占位**
2. **OriginalRewriteStage 整剧重写** —— 项目级 ≤3GB,`category==="ORIGINAL"` 专属,**app1 的第 6 个阶段**
   (5 阶段计划文档**漏列了它**)。dramaforge 完全没有此 UI。

海外 OVERSEAS 项目不直接跑长视频,而是 `scriptData.sourceMode==="ORIGINAL_PROJECT"` + `sourceProjectId`
引用一个 ORIGINAL 项目的整剧重写产物当源,再走 text-to-style 本地化。

---

## 1. dramaforge 现状判定(脚手架有,端到端不通)

| # | 子件 | app1 | dramaforge | 完成度 | X1 实际 |
|---|---|---|---|---|---|
| 1 | `calculateKimiSegmentPlan` + 2 常量 | core/video/long-video-plan.ts | shared/long-video-plan.ts | ✅ 补齐 | **X1.1 44ff8f1** |
| 2 | Kimi provider 视频理解(upload+SSE analyze) | core/video/kimi-client.ts 680行 | server/gateway/providers/kimi.ts | ✅ 补齐 | **X1.3 02fbf11** |
| 3 | `/api/generate/text`(云端入口) | n/a(app1 内部直调) | web/api/generate/text | ✅ 替换 501 stub | **X1.4 0ff75d9** |
| 4 | route wiring 测试 | — | test/generate-text.test.ts | ✅ 7/7 绿 | **X1.5 ebba594** |
| 5 | ModelCapability `video_understanding` | — | gateway/types.ts | ✅ | X1.3 内 |
| 6 | DB `longVideoProgress` 列 + `LONG_VIDEO_REWRITE` render-job 派发 | BullMQ | 0001-init.sql + dispatch.ts | ✅ 早已就绪 | — |
| 7 | `client/orchestrators/long-video-rewrite.ts` | long-video-service.ts 1553行 | 197 行**薄桩** | ⚠️ 桩 | **X3 重写** |
| 8 | OriginalRewriteStage UI + page.tsx ORIGINAL 分流 | OriginalRewriteStage.tsx 207行 | 无 | 🔴 缺 | **X3** |
| 9 | InputStage 视频 Tab 真实启用 | InputStage mode=video | disabled 占位 | ⚠️ 桩 | **X2** |
| 10 | 6 个转绘 route(video-to-script/full/batch/split/original-video-upload/health) | 5+1 route | 0 | 🔴 缺 | **X2/X4** |
| 11 | DeepSeek 大纲/三段重写/导演板/断点续跑/结构门禁 | long-video-service.ts ~450行 | 无 | 🔴 缺 | **X3** |
| 12 | character-mapping / whole-script-asset-extraction | core/video/* | 无 | 🔴 缺 | **X2/X4** |

---

## 2. 最大架构冲突 + 解法(3GB 视频过 Kimi)

**冲突**:Kimi Files API 必须用**服务端 key** POST 字节(GC-1:key 只在云端);但 dramaforge-assets-client-local
禁止字节**存**服务器。

**解(方案 A,唯一合规)** = **透传不落盘**:
- client 从本地 sf-asset:// 读字节 → 流式 POST 到 server route
- server route 接收流 → **直接 pipe 给 Kimi Files API**(持云端 key)→ 拿 fileId → **不写盘**
- server 再用 fileId 调 Kimi chat 分析 → 返回文本
- 服务器 RAM 只短暂持单段(≤48MiB)缓冲;key 在云端,字节不持久化 → 双铁律满足

> X1 已用 base64(现 orchestrator 契约)证明服务端链路通;**3GB 流式重写留 X3**
> (现 orchestrator 的 `videoBase64: buf.toString('base64')` 全量进 body,3GB 必爆 RAM,X3 改流式)。

---

## 3. X1-X4 路线(用户选一把梭)

### X1 解除阻塞(5-7 天)—— **自动化侧已完成 2026-07-21**
- [x] X1.1 shared `calculateKimiSegmentPlan` + 常量 (44ff8f1)
- [x] X1.3 gateway `video_understanding`(upload+SSE analyze+5次退避+600s/120s 超时) (02fbf11)
- [x] X1.4 `/api/generate/text` 501→实现 (0ff75d9)
- [x] X1.5 route 7 测试 (ebba594)
- [ ] X1.6 server kimi.ts provider 单测(mock fetch,验 upload+SSE parse+retry)—— 待补
- [ ] X1.7 真 Kimi 冒烟 —— 待部署后手动(云端 key + 真视频段)
- X1.2(LongVideoRewriteInput 扩展 + 类型冻结)**挪到 X3**,跟 orchestrator 重写一起落

### X2 单集视频转剧本路径(4-5 天,依赖 X1)
- `POST /api/projects/[id]/video-to-script`(100MB multipart → Kimi 理解 → 单集 draft)
- `GET .../video-to-script/health`(Whisper/OCR 挪 client 后的健康检查方式待定)
- InputStage 视频 Tab 启用(替换 disabled 占位)
- character-mapping-service(语义角色标注,首集建 projects.characterMapping)
- aux-clients(Whisper/OCR)→ 挪 client render-worker

### X3 整剧重写主链(12-15 天,最重,依赖 X1)
- `client/orchestrators/long-video-rewrite.ts` 197 行 → ~1500 行:
  - ffmpeg splitVideoForKimi(等长+强制关键帧,扩 splitVideoEvenly)
  - 分段 Kimi analyze(调 X1.4 route,不再 base64 全量;**X3 改流式**)
  - 断点持久化(userData/long-video-checkpoints/)
  - **DeepSeek 大纲**:reduce→initialOutline→连续性板→三段大纲(移植 long-video-prompt.ts 731行)
  - **DeepSeek 三段顺序重写**+续写+结构门禁+自动返修+段间导演板
  - 进度心跳(30s)防 render-job lease 被 reap
- 纯工具函数挪 shared/long-video-utils.ts(appendModelContinuation/inspectScriptRangeStructure 等 ~20个)
- `original-video-upload` route(3动作,字节落 client 本地 + 仅 server 记 meta)
- OriginalRewriteStage UI(207行整体移植)+ page.tsx `category==="ORIGINAL"` 分流 + stage-config 顶层 viewMode
- X1.2:扩 LongVideoRewriteInput + 冻结 LongVideoProgress/Result 类型
- 测试:重写 orchestrator 6 个 mock 测试为完整流程

### X4 批处理 + 拆分 + 整剧资产提取(3-4 天,依赖 X3)
- `video-to-script-full`(自动建集 + 写 scriptData)
- `video-batch-process`(多集批处理)
- `video-split`(长视频→多集,派 SPLIT_BY_DURATION render-job)
- `whole-script-asset-extraction`(整剧资产提取,OVERSEAS defer 判定)

**总计 ~25-30 工日**,单 X3 比批7 production 还重。

---

## 4. 三大风险(点名)

1. **3GB 视频过 Kimi 的 C/S 流式适配**(X3):现 base64 全量进 body 必爆 RAM,必须重写流式
   (client fs.openAsBlob 零拷贝 → 流式 multipart → server pipe Kimi 不落盘)。
2. **client orchestrator 从未真跑**(只过 mock 测试):Kimi/DeepSeek 实际超时/续写/结构门禁在 C/S 未验证,联调量大。
3. **DeepSeek 续写+结构门禁+导演板**(app1 ~450行)极复杂,app1 自己都为此加了一堆 env patch
   (`LONG_VIDEO_REGENERATE_*`),移植期易出续写死循环/断点不匹配/段间承接断裂。
4. **render-job lease 心跳**:DeepSeek 单次大纲/重写 15-30 分钟,需确认 dramaforge lease stale 阈值能覆盖,
   否则任务被 reap。app1 `withHeartbeat` 30s 心跳必须移植。

---

## 5. app1 关键文件绝对路径(移植参考)

- UI:`F:\app1\src\app\workspace\[projectId]\components\OriginalRewriteStage.tsx`(207行)
  + `InputStage.tsx:445-660`(单集视频Tab) + `page.tsx:647-648`(ORIGINAL 分流)
- core/video:`long-video-service.ts`(1553行)· `long-video-prompt.ts`(731行)· `long-video-plan.ts`(66行)
  · `kimi-client.ts`(680行)· `video-to-script-core.ts`(425行)· `character-mapping-service.ts`(706行)
  · `whole-script-asset-extraction.ts`(117行)· `aux-clients.ts`(Whisper/OCR)· `resource-manager.ts`
- API:`projects/[projectId]/` 下 `video-to-script`(+health)·`video-to-script-full`·`video-batch-process`
  ·`video-split`·`original-video-upload`

## 6. dramaforge 待改文件(绝对路径)

- shared:`long-video-plan.ts`(✅ X1.1)· `render-job.ts:107`(LongVideoRewriteInput,X3 扩)· `project.ts:106`(longVideoProgress,X3 冻结类型)
- server gateway:`providers/kimi.ts`(✅ X1.3)· `types.ts`(✅ X1.3)
- web route:`api/generate/text/route.ts`(✅ X1.4)· `api/projects/[id]/`(下缺 6 route,X2/X4)
- web UI:`workspace/[projectId]/components/InputStage.tsx:411-414,665`(Tab 桩,X2)· 缺 `OriginalRewriteStage.tsx`(X3)· `page.tsx`(X3 ORIGINAL 分流)
- client:`orchestrators/long-video-rewrite.ts`(197行桩,X3 重写)· `ffmpeg`(X3 扩 splitVideoForKimi)

---

> GC-3:app1 只读,绝不改 F:\app1。所有移植遵循 C/S 三铁律:GC-1(key 云端) /
> dramaforge-assets-client-local(媒体字节客户端,server 透传不落盘) / dramaforge-keys-cloud-server-only。
