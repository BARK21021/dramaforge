# 架构硬约束 / app1 迁移 / 已知坑 (System of Record)

> 从 Claude 记忆合并 2026-07-27。Liveness: ✅current · ⚠stale · 📦historical
>
> 本文件是 dramaforge 架构硬约束与 app1 迁移类知识的 **记录系统**。机械 hook
> `.claude/hooks/guard-invariants.py` 在违规时回指本文件 §H1/§H2。

---

## 🔒 硬约束（机械强制，见 `../../.claude/hooks/guard-invariants.py`）

### H1 媒体资产只存客户端本地 [⚠ 部分成立]

**规则**：所有媒体字节（视频/音频/图片）只准存 Electron 客户端本地硬盘（appData,
`sf-asset://`）。服务器（含 MinIO / 本地 FS）**不下载、不转发、不落盘任何媒体字节**；
只持 AI key + DB 元数据（GC-5 服务器零带宽零存储 = 不 OOM）。

**Why**：用户 2026-07-19 原话「所有资产等都要放本地，不准放云服务器」；契合 C/S 哲学
（服务器薄、客户端重）。推翻了早期 P4 brainstorm「落 MinIO + 稳定 URL」方案。

**How to apply**：要存媒体 → 客户端 appData，经 main 进程 IPC 下载/写盘（渲染进程沙箱
不能直接写盘）。生成流程：客户端 → 服务器路由（服务器用 server-side key 调 AI）→
服务器返 provider 临时 URL → **客户端立刻下载到本地** → `<video>` 放本地文件。

**Hook 行为**（`guard-invariants.py:64-93`）：扫 `Write/Edit/NotebookEdit` 工具输入内容，
在 `packages/server/**` 内若同时出现对象存储入库（`putObject|upload|...`）+ 媒体上下文
（`.mp4|.mov|video/|...`）→ **exit 2 阻断**；fs 写盘 + 媒体扩展名同理阻断。仅对象存储
入库但无媒体上下文 → warn 不阻断。**hook 只守新编辑，不扫存量代码。**

**核实结果（2026-07-27）**：
- ✅ **chain 编排路径（主生产路径）已对齐**：`packages/server/src/ai-worker/handlers.ts:484-489,528-532`
  明确 `chainMode` 时跳过 `persistVideo`，注释直接引用「dramaforge-assets-client-local：媒体只存
  客户端本地，服务器零媒体字节」，ark TOS URL 直接交客户端 `downloadClips` 落盘。
- ✅ **项目导入导出路径已对齐**：`packages/server/src/domain/project/transfer.ts:1-7` 顶层注释
  「云端只搬运元数据；sf-asset:// 媒体文件由 Electron 客户端写入 .sfproject 文件夹」。
- ⚠ **存量 H1 偏离（未被 hook 拦，因 hook 只扫新编辑）**：
  - `handlers.ts:346,659-703` `persistImages()`：单镜头 `IMAGE_GENERATE` 仍下载 AI 图片字节
    并 `storage.upload(key, buf, contentType)` 入库（`assets/{projectId}/...` 或 `generated/{projectId}/...`）。
  - `handlers.ts:511-728` `persistVideo()`：**非 chain 单镜头 `VIDEO_GENERATE`** 仍走
    `await persistVideo(...)`（`handlers.ts:532` 的 `chainMode ? videoUrl : await persistVideo(...)`
    分支），下载视频字节并入库到 `videos/{label}-...mp4`。注释自承「复刻 app1 VideoWorker.persistVideoUrl」，
    即 **app1 遗留路径未做 C/S 改造**。
  - 存储层 `packages/server/src/domain/storage/{factory,minio,local,cos}.ts` 仍在产线；
    `STORAGE_PROVIDER` 默认 `local`（落 web/server 容器本地 FS），`docker-compose.yml`
    MinIO 服务 + `MINIO_ACCESS_KEY/SECRET_KEY` env 仍配齐；P0 presign-GET 路由
    (`packages/web/app/api/storage/presign/route.ts`) 仍活。
- 结论：**chain 主链路对齐**，但单镜头图片/视频路径与存储层是 **app1 遗留债**，需后续清退
  才能宣称 H1 全量成立。
- 📦 **参考视频切片 relay = 有界瞬态例外（REFERENCE_VIDEO，2026-08-01）**：
  `POST /api/storage/presign` 只签发 presigned PUT URL，切片字节客户端直传 MinIO、
  ARK 直拉 presignDownload URL，**web 服务器零字节落地**。切片 TTL 7 天（MinIO 上限）、
  客户端 chain 完成后 `DELETE /api/projects/[id]/reference-video/clips` 删对象 +
  POST 时 lazy sweep 超 24h 孤儿 key（对象过期不可访问即失效）。hook 正则
  `\.(putObject|upload|...)\(` 不匹配 `presignUpload(`/`delete(`，故不拦；本注记为
  审计留痕。仅 MinIO/COS 后端可用（local 后端 presign 返 localhost，火山拉不到）。

---

### H2 AI key 只在云端服务器 [✅ 成立]

**规则**：AI provider key（ARK/豆包/Kimi/DeepSeek 等）**只在云端生产服 env**
（your-domain.example.com / YOUR_SERVER），是**平台（运营方）的 key**；end-user **无 BYOK**，
客户端代码、客户端 UI、客户端 env 全部不持 key。本地无法做真实生成测试，只能结构/契约验证。

**Why**：用户 2026-07-19 原话「key 只能用云端的，用户不能用自己的」。强化 GC-1：不是
「用户上传 key 到服务器」，而是「key 本就是平台服务器的，用户根本没有 key 概念」。

**How to apply**：① UI 绝无 key 输入框；② 调 AI 走服务器路由用 server-side key；③ 本地
docker 跑不出真生成（本地 .env 没平台 key），路由返 `502 PROVIDER_API_KEY_MISSING` 即证明
接线对；真生成只在云端。

**Hook 行为**（`guard-invariants.py:95-113`）：扫工具输入内容，在 `packages/client/**` 内若
出现裸 provider key 字面量（`sk-...` 或赋给 `*_API_KEY/*_SECRET/*_TOKEN` 的 ≥24 字符串）→
**exit 2 阻断**；引入 provider key 变量名但无字面量 → warn。

**核实结果（2026-07-27）**：
- ✅ `packages/client/src/` 全量 grep `API_KEY|apiKey|api_key|SECRET_KEY|secretKey|accessKey|BYOK` **零命中**。
- ✅ `packages/client/main/index.ts` 仅用 `process.env.SF_DEV_URL`（API base）+ `process.env.VITEST`
  （测试守卫），无任何 provider key env。
- ✅ Web 工作台组件 `InputStage.tsx:30 / AssetDesignStage.tsx:29,64,67 / AnalyzingStage.tsx:50 /
  StoryboardStage.tsx:37 / OriginalRewriteStage.tsx:42` 全部显式标注「GC-1（BYOK 禁）：无 key UI」。
- ⚠ `packages/server/src/gateway/credentials.ts` 的 per-user `api_configs` 表仍存在（app1 遗留设计），
  但**只走 admin 后台**（`packages/web/app/api/admin/api-configs/import/`），**非 end-user 产品流程**，
  不违反 H2。

---

### H3 前端视觉/交互照搬 app1 [✅ 成立（流程性约束）]

**规则**：dramaforge 前端 UI 视觉与交互必须**对齐 app1 参考仓**（`D:\app1` / `F:\app1`，只读）。
用户 2026-07-19 原话「最重要的是前端需要对齐 app1」。「前端不能改」= 前端要跟 app1 一模一样，
**不是「别动前端」**；结构/数据层可用 dramaforge 新契约（apiSuccess/apiFail envelope、camelCase
SQL 列、纯 UUID `genId()`），**视觉层（布局/配色/间距/组件长相/文案）照搬 app1**。

**Why**：app1 是已上线生产 UI，用户认可其设计语言；dramaforge 复用同一套视觉，不自创。

**How to apply**：做任何 dramaforge 前端页面前，先读 app1 对应页面的组件结构、Tailwind 类、交互模式、
文案，照搬视觉到 dramaforge。落地页是「DramaForge」电影级页（Canvas 金尘粒子+光环+衬线标题+CTA+声波条）
整页搬入。⚠ dramaforge middleware 是「客户端专属网关」：落地页**仅 Electron UA 可见**，普通浏览器
访 `/` 仍 307→`/download`（有意设计，别改）。

**Hook 行为**：**H3 不由机械 hook 强制**（视觉对齐无法静态判定），靠流程纪律 + 视觉检查 skill。

**核实结果（2026-07-27）**：
- ✅ dramaforge 工作台 stage 命名与 app1 阶段一一对应：`InputStage / AnalyzingStage / AssetDesignStage /
  StoryboardStage / ProductionStage / OriginalRewriteStage`（app1 第 6 阶段）。
- ✅ 组件代码注释显式引用「GC-6（行为等价）：A1-A14 镜像 app1」（见 AssetDesignStage.tsx:67 等）。
- ⚠ 像素级视觉对齐在本环境无法核（无 app1 参考仓 + 无真客户端截图）；以流程纪律为准。

---

## 迁移类 issue

### video-to-script / 整剧重写链路（X1-X4 转绘） [✅ code-complete]

**Symptom**：app1「转绘」有两套——① InputStage 单集视频转剧本 Tab（≤100MB）② OriginalRewriteStage
整剧重写（项目级 ≤3GB，`category==="ORIGINAL"`，app1 第 6 阶段）。海外 OVERSEAS 不直跑长视频，
而是引用 ORIGINAL 项目的整剧重写产物当源。

**Rule / 架构冲突解法**：dramaforge-assets-client-local 禁媒体字节存服务器 + Kimi Files API 必须服务端
key POST 字节 → **方案 A 透传不落盘**：client 从本地 `sf-asset://` 读字节 → 流式 POST 到 server
route → server 直接 pipe 给 Kimi → 拿 fileId 不写盘 → 返文本。server RAM 只短暂持单段 ≤48MiB。

**Refs / 落地证据**：
- `packages/server/src/gateway/providers/kimi.ts`：`uploadVideoFile` + `analyzeVideoSegmentStream`
  + `extractVideoContextStream` + `generateScriptFromVideoStream`（SSE chat + 5 次指数退避 +
  600s 总超时/120s idle）。
- `packages/web/app/api/generate/text/route.ts`（X1，video_understanding，multipart/form-data）
- `packages/web/app/api/generate/long-video-text/route.ts`（X3.3，DeepSeek 续写 + 余额熔断回退 kimi）
- `packages/web/app/api/projects/[id]/episodes/[episodeId]/video-to-script/route.ts`（X2，单集 ≤100MB）
- `packages/web/app/api/projects/[id]/video-to-script-full/route.ts`（X4.1）
- `packages/web/app/api/projects/[id]/video-batch-process/route.ts`（X4.2，dramaforge 砍到 ≤5 集）
- `packages/web/app/api/projects/[id]/video-split/route.ts`（X4.3）
- `packages/server/src/domain/asset/whole-script-asset-extraction.ts`（X4.4）
- `packages/web/app/api/projects/[id]/long-video-rewrite/{progress,result}/route.ts`（X3.6）
- `packages/web/app/api/projects/[id]/original-video-upload/route.ts`（X3.6b，纯元数据派发）
- `packages/web/app/api/render/dispatch/route.ts` 含 `LONG_VIDEO_REWRITE` case（X3.6b）
- `packages/web/app/workspace/[projectId]/components/OriginalRewriteStage.tsx`（X3.7，608 行）

**Gotcha**：3GB 流式分段是架构级（单段 ≤48MiB + 并发限 4），未做真 3GB Kimi E2E 实测（本机无 key）；
Whisper/OCR/character-mapping/health route 全 defer。同志把 `/api/generate/text` 改
multipart/form-data 后，X3.4 orchestrator 必须用 FormData 调（已对齐）。

---

### 整剧重写本地暂存 OOM 修复（R1 流式） [✅ 已修]

**Symptom**：用户报「整剧重写功能失效」「本地暂存视频失败」——字面量 `"本地暂存视频失败"` 全代码库
仅 `OriginalRewriteStage.tsx` 一处抛出。根因：`sf:stage-original-video` IPC handler 用
`await file.arrayBuffer()` 把 ≤3GB 视频整块读进 main 进程堆 → 撞 V8 单 ArrayBuffer / IPC 结构化克隆
上限 → READ_ERROR。

**Rule**：renderer 侧用 `webUtils.getPathForFile(file)` 解析磁盘绝对路径，**只把路径字符串过 IPC**
（不再过 File），main 侧 `stageOriginalUploadFromPath` 用 `pipeline(createReadStream, createWriteStream)`
流式 copy，内存恒定。

**Refs**：
- `packages/client/main/asset-store.ts:675-760` `stageOriginalUploadFromPath`（流式 copy，3GiB 上限校验）
- `packages/client/main/preload.ts:277-282` 用 `webUtils.getPathForFile` 解析路径
- `packages/client/main/index.ts:54,690-760` IPC handler 优先路径契约，保留 file→arrayBuffer fallback 供测试
- `packages/client/test/shell/asset-store.test.ts:395+` `stageOriginalUploadFromPath` 单测套件
- R2（`:309` 错误透传 + MKV/HEVC 放行）/ R4（轮询 10 次失败弹 toast）见 `OriginalRewriteStage.tsx`
- R3 评估后回退（render-worker loop 已 catch + R4 兜底，冗余）

**Gotcha**：`webUtils.getPathForFile` 仅对原生 `<input type=file>` 的 File 返真实路径（合成 File
返 ''→INVALID_INPUT）；整剧重写 UI 走原生 input 故 OK。R1 客户端 1.1.14 已软推；R2/R4 在 web
云端镜像，需 deploy.sh 才生效。**真客户端 3GB 实测未做**（本机无 Kimi key + 3GB 流式是架构级）。

---

### 项目导入导出 / 跨电脑迁移 [✅ 已实现，记忆 stale]

**Symptom**：用户 2026-07-21 需求——换电脑客户端能导入/覆盖项目用。缓解 `dramaforge-assets-client-local`
导致的跨机器 `sf-asset://` 失效痛点。

**Rule / 方案**：**client 主导 + 云端只搬元数据**（不违反 H1）：
- 导出：client `exportProjectBundle` IPC → `GET /api/projects/[id]/transfer` 取元数据快照 + 客户端
  读本地媒体 → 打包 `.sfproject` 目录（大视频流式 copyFile，不进 renderer 内存）。
- 导入：client `importProjectBundle` IPC → 用户选 `.sfproject` → 客户端恢复本地媒体并改写 URL →
  `POST /api/projects/import`（body=已改写 URL 的快照）→ 服务端 `importProjectSnapshot` 克隆入库
  （**新 projectId 避免冲突**，`sf-asset://` localKey 保持原值，新机器直接可用）。
- 元数据永不入迁移包的：任务、计费、密钥等账户数据（`transfer.ts:41` 注释）。

**Refs**：
- `packages/server/src/domain/project/transfer.ts:42` `exportProjectSnapshot` + `:155` `importProjectSnapshot`
  + `ProjectTransferError` + `TRANSFER_VERSION=1` + `TABLE_ORDER=[episodes,assets,storyboards,shots,materials,asset_image_revisions,render_jobs]`
- `packages/server/src/domain/project/index.ts:42` + `packages/server/src/index.ts:163` barrel re-export
- `packages/web/app/api/projects/[id]/transfer/route.ts` GET（导出）
- `packages/web/app/api/projects/import/route.ts` POST（导入，32MiB body 上限）
- `packages/client/main/project-bundle.ts:77+` `exportProjectBundle` / `importProjectBundle`（流式 copyFile）
- `packages/client/main/ipc-channels.ts:55-58` `sf:export-project-bundle` / `sf:import-project-bundle`
- `packages/client/main/index.ts:809-855` IPC handler + `dialog.showOpenDialog`
- `packages/client/main/preload.ts:242-291` 暴露 `exportProjectBundle` / `importProjectBundle` API

**Gotcha**：记忆（dramaforge-project-import-export）标「排期批10」已 **stale**，实际已全链路实现。
导出路由名为 `/api/projects/[id]/transfer`（GET），**不是** 记忆推测的 `/export-bundle`。

---

### 任务切页/切集不中断（在途任务层） [⚠ Stage1 done, Stage2 未做]

**Symptom**：dramaforge B 方案「每集独立路由」，切集 = `router.push` → 当前集 `EpisodeWorkspace`/`InputStage`
整个 unmount，组件局部瞬态（taskId/uploading/fetch 归属/终态去重 ref）全丢 → 任务中断/失败。
app1 是 SPA 多 Tab 不卸载所以没这问题；dramaforge 的 B 方案是偏差。

**Rule**：导航无关的「在途任务」层——任务执行+瞬态从组件提到模块级单例 store，组件只订阅。
视频转剧本尤其脆弱（raw File 流必须 HTTP 一直开着，切集断流即 FAILED）。

**Refs / 现状**：
- ✅ **Stage1 done**：`packages/web/lib/video-upload-store.ts`（模块级单例 + `useSyncExternalStore`
  + sessionStorage 恢复 + 终态回调）+ `packages/web/app/.../InputStage.tsx` 视频路径用 hook。
- ⚠ **Stage2 未做**：`packages/web/app/workspace/[projectId]/components/EpisodeWorkspace.tsx:524`
  `activeTaskIds` 仍只有 `useState<Set<string>>(new Set())`（init）+ `:563 next.delete(...)`（remove），
  **从没 `.add(...)`**。代码 `:575` 自承注释明确承认「从未 add 到本 activeTaskIds React state」。
  → 顶栏 `ActiveTaskStatusBar`（`:705-707`）`size` 恒 0、`isBusy` 恒 false、`page.tsx handleBusyChange` no-op。
- ⏳ Stage3-5（分析阶段多步序列、storyboard sync-direct 锁恢复、五类任务冒烟）全待做。

**Gotcha**：切集丢任务是用户高频痛点，B 方案架构债。续做照 Stage1 的 store+hook 模式（模块级 Map
by key + useSyncExternalStore + ref 持有内联回调），不要把 fetch/state 留在 stage 组件里。

---

### 单集视频转剧本中文文件名 502（Kimi /files） [✅ 已修]

**Symptom**：dramaforge 单集 `/api/projects/[id]/episodes/[eid]/video-to-script` 对含中文/全角字符的文件名
必 502。Moonshot `/v1/files` 对「百分号编码的多字节 UTF-8 文件名」解析直接 400
`{"error":{"message":"Invalid request: http: no such file"}}` → 整个 file part 被丢弃 → 后续 chat
无文件可用 → `EmptyScriptError` → route 返 502。

**Rule**：multipart 头删掉 `filename*=UTF-8''...` 子句与 `encodedName`，固定 `filename="video.mp4"`。
Kimi 后续按 `ms://fileId` 引用、不依赖文件名；真实 MIME 由 Content-Type 承载。

**Refs**：
- `packages/server/src/gateway/providers/kimi.ts:165` 注释解释根因（400 "http: no such file"）
- `kimi.ts:172` 固定 `filename="video.mp4"`（无 `filename*`）
- `kimi.ts:621` fallback `input.filename ?? 'video.mp4'`

**Gotcha**：为什么 X1 video_understanding 没踩坑？X1 (`/api/generate/text`) 由客户端 ffmpeg 切片，
分片名是 ASCII（`segment-xxx.mp4`）；X2 单集直接传用户原始文件名才命中。可观测性坑：web 容器对
500/502 静默（不落 docker logs），定位全靠 `api_configs.lastErrorMessage` 列。

---

### chain-generate base64 Redis 炸弹 [⚠ 方向锁定，未实现]

**Symptom**：dramaforge BullMQ job 胖 payload——`packages/client/src/orchestrators/chain-generate.ts`
`applyCharacterReferenceGrid` 把人物参考图（叠网格）、参考图、参考音频、组间末帧全转
`data:image/...;base64,` 内联进 group dispatch body → `VIDEO_GENERATE` task input → **BullMQ job
data → Redis**。每 job ~4-5MB，13 镜头 = 70M，100 人并发必炸 Redis（maxmemory 64mb 时 4928 一条
链顶到 69.76M）。

**Why（架构悖论）**：服务端 ai-worker 调 ark 够不着客户端本地 `sf-asset://`（H1 服务器零媒体字节），
故客户端只能 base64 内联让服务端拿得到。base64 是当前唯一 transport。

**Rule / 用户拍板（2026-07-24）**：**真流式·服务器零存储**——ai-worker 处理 job 时经新建双向通道
从客户端拉参考资产，直管道到 ark，job 不带 base64、不进 Redis、服务端不落盘。不走短 TTL 瞬态缓存
（会放宽 H1）。chain 模式客户端本就在线等结果，天然满足「ai-worker 跑时客户端在线」。门禁反馈
（surface 成功镜头·不造假整片·停 G3-1 把成功镜头标 FAILED）一坨设计一坨改。

**Refs / 现状**：
- 根因代码：`packages/client/src/orchestrators/chain-generate.ts:279,325,903,1022` 仍在用
  `data:${mime};base64,${bytes.toString('base64')}` + `readFile(...).toString('base64')`（**未改造**）。
- 当晚止血（运行时可逆）：Redis maxmemory CONFIG SET 64mb→256mb；治本需 `docker-compose.yml` 写死
  256mb（记忆 dramaforge-cloud-deploy-state 续53 提交 256→384mb，见 `docker-compose.yml` 现况）。
- 待设计：客户端↔服务端双向流式通道 + asset-fetch RPC（复用 machineId/claimToken 模型）+ ai-worker
  处理时拉资产 + ark 网关流式上传（待探：ark 收 base64 JSON 还是 multipart？）+ dispatch 改带资产引用
  + 门禁 partial 回写 + 成片库失败时不生成 + 客户端 surface 成功镜头 + 向后兼容（旧客户端仍 base64）。

**Gotcha**：此为架构级重做，未排期；4928 那条链不单独追（Seedance 拒了 4 镜头，重试也得先解决内容）。

---

## 记忆指针回溯表（hook 报错时回指）

| hook 触发 | 回指记忆（薄指针，勿删） |
|-----------|-------------------------|
| H1 阻断/warn | `dramaforge-assets-client-local`（规则原话+Why+How to apply） |
| H2 阻断/warn | `dramaforge-keys-cloud-server-only`（规则原话+Why+How to apply） |
| H3（无 hook，纪律） | `dramaforge-frontend-align-app1` + `dramaforge-is-app1-cs-migration` |
