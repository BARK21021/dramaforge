# Chain 编排 / 假死 / 计费死循环 (Known Issues)

> System-of-record,从 Claude 记忆合并 2026-07-27。Liveness: ✅current(代码核实) · ⚠stale(代码变了待核) · 📦historical(已解决留档)
>
> 核实基线:`D:\dramaforge-cs` 当前工作树。每条都对照 `packages/server/src/task/`, `packages/server/src/domain/`, `packages/server/src/ai-worker/`, `packages/client/src/orchestrators/`, `packages/web/app/api/`。
>
> **回归守卫（doc 级）**:① 假死诊断已机械化 → `scripts/diagnose-stuck-chain.sh`（交叉验 claim 硬上限 + 日志活动 + 扣费推进 + result，阈值镜像 `maxClaimDurationSecondsForType`）；② 运行时自愈 sweep `renderJobRepo.sweepStuckShots()`（60s，锁「镜头不永久卡 GENERATING」）+ `reapStale` claim 硬上限（4h / LONG_VIDEO_REWRITE 12h）。各 issue 的细化守卫见条目内「Rule / fix」。

---

## CHAIN_COMPILE 假死:claim 硬上限兜底心跳续租 [✅]

**Symptom:** CHAIN_COMPILE render_job 长期 `status=RUNNING`、`heartbeat_at` 新鲜(client `loop.ts` renewLease 30s 定时器仍续租),但 `result` 一直空、零产出;render-worker 单线程被占住 → 后续 CONCAT 也堆积 PENDING 不被领取。前端任务转圈不前进。

**Root cause:** `reapStale`/`claimNext` 回收条件只看 `COALESCE(heartbeat_at, claimed_at) < now()-120s`(DEFAULT_RENDER_JOB_LEASE_TIMEOUT_MS=2min),但客户端 `loop.ts` 心跳定时器**独立于 executeJob** —— executeJob 卡死(ffmpeg/AI 请求挂起不返回)时心跳定时器照样每 30s 续租 → heartbeat_at 永远新鲜 → reap 永不回收 → 永久假死。

**Rule / fix:** 服务端 `render-job-repo.ts` 加 `MAX_CLAIM_DURATION_SECONDS=4*60*60` 硬上限(4h:CHAIN_COMPILE strict 一键出片逐组串行+真实云端生成,典型 30-60min、大分集 ~1h+,心跳每 30s 续租即活;超 4h 且心跳始终新鲜才判定卡死),`reapStale` 的 `staleCond` 和 `claimNext` 回收 UPDATE 各加一条 `OR claimed_at < now()-interval'4 hours'`(不看心跳)。回收后客户端下一次 `/progress` 续租因 claim_token 失配收到 409 → `loop.ts` `executionController.abort()` 中断卡死的 executeJob → worker 释放领新活。**LONG_VIDEO_REWRITE 单独分档 12h**(Kimi 分段+DeepSeek 大纲+多段重写循环单次编排典型 1-6h,套统一 4h 会把仍在合法编排的原 job 当卡死回收,丢 in-flight LLM 调用)。`maxClaimDurationSecondsForType(type)` 纯函数供单测。

**Live gotcha:** 监视卡死任务**不能只看 heartbeat**(客户端进程活着≠生成在推进)。必须交叉验:① 近 N 分钟 web/ai-worker 日志有无生成活动;② `billing_ledger` 真实扣费是否推进;③ `result` 是否产出。心跳新鲜但日志零活动=假死。

**Refs:** `packages/server/src/task/render-job-repo.ts:107,120,132-138,1076-1086,1080-1086`; `packages/server/src/ai-worker/index.ts:109`; `packages/client/src/.../loop.ts`(renewLease + abort); [[dramaforge-render-job-fakedeath-fix]] [[dramaforge-fatality-audit-20260727]]

---

## 运维裸 SQL UPDATE 绕过 G3-1 级联 → 镜头永久卡 GENERATING [✅]

**Symptom:** 用户(如 4928)前端进度条/镜头级转圈卡死,**刷新页面也不停**。查 render_jobs/tasks/Redis BullMQ 全是终态、0 非终态,看似服务端无卡死 job;但 shots 表里 `videoStatus='GENERATING'` 堆积。

**Root cause:** chain-generate 创建 render_job 时把组内镜头 `videoStatus` 标 `GENERATING`。job 正常失败走 `POST /api/render/jobs/[id]/failed` 路由时后端 G3-1 级联会把这些 shots 标 FAILED。但运维手动止血(直接 SQL `UPDATE render_jobs SET status='FAILED'`,即 render_jobs.error 里那些 `[MANUAL-INTERVENE]` 记录)**绕过了 /failed 路由**,G3-1 级联不触发 → shots 永久卡 GENERATING → 前端按 videoStatus='GENERATING' 显示转圈,刷新重拉还是 GENERATING。

**Rule / fix:** 两层兜底:
1. **正确止血入口** `renderJobRepo.forceFail(id, reason)`(无 lease token,从 PENDING/CLAIMED/RUNNING 任一非终态 CAS→FAILED + 复刻 G3-1 镜头级联)+ admin route `POST /api/admin/render-jobs/[id]/force-fail`(requireAdmin,对齐 /failed:级联 + `refundTaskDebit(r.job.taskId)`(**不是 r.job.id,用主键查 billing 永不退款=资损**)+ `publishTaskEvent` SSE→前端实时停转)。**替代裸 UPDATE,立即生效+SSE。**
2. **终态级联兜底 sweep**(铁律级)`renderJobRepo.sweepStuckShots()`:每 60s 借宿 ai-worker(`startRenderJobCascadeSweep`),扫近 24h 终态 CHAIN_COMPILE job(FAILED/CANCELLED),把它声明但仍卡 `videoStatus='GENERATING'` 的镜头强制对齐(FAILED job→FAILED / CANCELLED job→PENDING)。幂等(只动 GENERATING)。**让"镜头永久卡 GENERATING"不可能发生,最多滞后 60s,不管怎么绕过级联(裸 UPDATE/崩溃/bug)。**

**Live gotcha:** 运维要推链任务失败**先走 admin route**,裸 SQL 仅在 web 不可用时兜底;裸 SQL 推完后**必须**手动 `UPDATE shots SET "videoStatus"='FAILED' WHERE "projectId"=... AND "videoStatus"='GENERATING'` 或等下一 tick(60s)的 sweep 兜底。`AND status='RUNNING'` CAS 守卫不可省(防误改已终态任务)。注意:DB 改 status 不通知客户端停,客户端 Electron 或成孤儿继续跑(次要)。

**Refs:** `packages/server/src/task/render-job-repo.ts:1247-1286 (forceFail),1298-1319 (sweepStuckShots)`; `packages/web/app/api/admin/render-jobs/[id]/force-fail/route.ts`; `packages/server/src/ai-worker/index.ts:128-145`; [[dramaforge-manual-intervene-shots-stuck]]

---

## CHAIN_COMPILE 计费 PENDING_DEBIT duplicate-key 死循环 + column 错位 [⚠]

**Symptom:** CHAIN_COMPILE render_job 假死时,web 日志每 5-7 分钟刷一波 `[billing] 写 PENDING_DEBIT 失败 ... duplicate key value violates unique constraint "idx_billing_ledger_user_task_type_unique"`(每个时间点冒 2 条=重试并发写两次),用户 balance 长期不扣(欠费漏损)。

**Root cause:** 两根因独立,同日都在活跃:
1. **duplicate-key 死循环**:chain compile 把整个串行任务当成**一个 taskId** 写计费 → 首次 PENDING_DEBIT 成功 → 客户端 render-worker 每隔几分钟重试生成,又拿**同一个 taskId** 写 PENDING_DEBIT → 撞 unique 键 `(userId, taskId, type)` → duplicate 失败没被短路/吞掉 → 镜头没真生成 → 下次再试 → 无限循环。
2. **column "userId" does not exist**:`chargeAggregatedTaskCost` 的 render_jobs 终态守卫错把 camelCase `"userId"` 用在 snake_case 表上(render_jobs 是 snake_case `user_id`/`task_id`/`created_at`;billing_ledger/tasks 才是 camelCase `userId`/`taskId`/`createdAt`)→ `pending-debit-sweep` 每 tick `{scanned:53, settled:0, errored:53}` 100% 失败,53 笔 PENDING_DEBIT 共 7781 credits 从未真正扣费。

**Rule / fix:**
- **column 根因**已于 `20260724-cutover` 修复并实证:`packages/server/src/domain/billing/service.ts:281` 改成 `WHERE task_id = $1 AND user_id = $2`(snake_case),且**按 `task_id` 查而非主键 `id`**(chargeAggregatedTaskCost 的 taskId = billingTaskId = `render_jobs.task_id`,按主键 id 查永远查不到→终态门形同虚设→FAILED/CANCELLED 后迟到结算仍被扣费=资损)。部署后 sweep 实测 `{scanned:78, settled:78, errored:0}`,78 笔全部结算成功。
- **duplicate-key 根因**未做直接代码根治,但**结构上被 chain-async 迁移消除**:chain 不再走 sync direct `/api/generate/video` 路径(那里调 `billDirectGeneration`→`recordPendingDebit`),改走 `/api/generate/video-async`(enqueueAiTask 派发)→ `recordPendingDebit` 在 chain 路径不再被调用,duplicate-key 风暴结构上不可能再发生。底层 `recordPendingDebit` 自身没加 duplicate 短路(单镜头 sync direct 仍走该路径,理论上有低频重试风险,无观察案例)。

**Live gotcha:** 监视假死任务**不能只看 heartbeat**,必须交叉验 `billing_ledger` 真实扣费是否推进。查计费风暴:`docker logs --timestamps --since 50m dramaforge-web 2>&1 | grep "PENDING_DEBIT 失败"`。查欠款:`SELECT count(*),sum(credits) FROM billing_ledger WHERE "userId"=X AND type='PENDING_DEBIT'`。

**Refs:** `packages/server/src/domain/billing/service.ts:257-393 (chargeAggregatedTaskCost),281 (task_id+user_id),425-514 (recordPendingDebit)`; tag `20260724-cutover`; [[dramaforge-chain-compile-billing-deadloop]]

---

## CHAIN_COMPILE 整链 0 产出:strict 跳过 vs 安全门禁互斥 [✅]

**Symptom:** dramaforge CHAIN_COMPILE 链「任一镜头失败 = 整链 FAILED = 用户零产出」。strict 热补丁(跳过失败组出部分片)与服务器安全门禁(all-or-nothing)设计互斥,导致 strict 跳过失败组后客户端只上报成功组 → 门禁拒 → 整链 FAILED(案例 4928 连续 4 条同死法,13 镜头 9 成功 + 4 被拒,从未出过片)。

**Root cause:** `readTrustedChainShotGroups()` 是安全 all-or-nothing 门禁(防篡改客户端借完成回调覆盖任意镜头):客户端上报组片数必须 `===` expectedGroups.length、每组 shotIds 必须逐个+顺序与服务器白名单完全一致、localKey/videoUrl 必须 `sf-asset://` 格式。任何不匹配 → 抛 `CHAIN_COMPILE 组片结果缺少完整的镜头映射` → markResult 的 `failed_validation` 分支判 FAILED + G3-1 镜头级联。strict 模式跳过失败镜头后客户端产出组片少这些 shotId → 组数/shotId 不匹配 → 门禁拒 → 整链 FAILED。strict 想出部分片,门禁拒部分片,互斥。

**Rule / fix:** **strict-aware partial 门禁**已落地(`render-job-repo.ts:261-322 readPartialTrustedChainShotGroups` + `335-377 persistPartialShotGroups`):门禁失败时从 `result.meta.groupClips` 按白名单 shotIds **内容匹配**挑出成功组(每个 reported 组必须 shotIds 与某个 expected 组完全一致、且 localKey/videoUrl 合法、不重复),只回写匹配且合法的组为 COMPLETED;不匹配/非法的 reported 组丢弃(其镜头归入 FAILED)。安全不变量不变:**只绑定服务端已声明 shotIds 的子集,篡改客户端无法借完成回调注入任意镜头**。`markResult` catch validationError 分支(行 896-973)在判 FAILED 前先调 partial 回写,缺失镜头标 FAILED + 把 `result.meta.failedGroupErrors` 写到对应镜头 metadata.videoError(前端在失败的镜头组旁展示具体报错)。

**Live gotcha:** 安全 critical 路径,改门禁必须保持"只绑白名单 shotIds 子集"不变量,任何放宽都可能开安全洞(篡改客户端借完成回调覆盖任意镜头)。partial 门禁**不**查 tasks 表核实缺失镜头确为 FAILED(曾考虑方案 A,未做),只信任客户端上报的成功子集+用白名单过滤。

**Refs:** `packages/server/src/task/render-job-repo.ts:173-246 (readTrustedChainShotGroups),261-322 (readPartialTrustedChainShotGroups),335-377 (persistPartialShotGroups),895-973 (markResult catch 分支)`; [[dramaforge-strict-vs-security-gate-deadlock]] [[dramaforge-chain-fakedead-hotfix-1117]]

---

## chain 假死上游根因:web reset 长连接(ark >5min) [✅]

**Symptom:** chain 视频生成(CHAIN_COMPILE)假死事故,4928 等用户任务 RUNNING 心跳活零产出卡 46-91min。单独生视频却不受影响(0 个 VIDEO_GENERATION render_job)。

**Root cause:** dramaforge 有两条视频生成路径并存——web 同步直连(`/api/generate/video`,web 进程同步等 ark 最长 25min)与 ai-worker 异步(`handleVideoGenerate` 全套齐备但 chain/单镜头都没用)。chain 逐组用同步那条;web = `next start`/Node 22 默认 `requestTimeout=5min`,任一组 ark >5min 被 web reset → nginx `recv() failed (104 Connection reset by peer)` 命中 `/api/render/jobs/[id]/result` + `/progress` + `/api/sse` → 客户端上报结果被 reset、前端收不到终态 → 心跳活结果上不来=假死直接成因。1.1.17 hotfix 全在客户端侧(per-group 10min 预算 + strict 跳过 + fast allSettled 完整性门禁),治不了 web 端 reset。

**Rule / fix:** **chain-async 架构重做**(tag `20260724-chain-async` + client 1.1.18 软推,**保壳换芯**):
- 保留 CHAIN_COMPILE render_job 外壳(心跳/reap/cancel/G3 全留,避免退回 dramaforge-task-survives-navigation 老问题);
- 只把 client `chain-generate.ts` 每组从同步 fetch 改 **ai-worker 异步**:新端点 `POST /api/generate/video-async`(enqueueAiTask 派发,不调 callAI,`VIDEO_ASYNC_TIMEOUT_MS=30min` 兜底)+ 客户端 `dispatchAndPollCloudVideo`(派发+轮询 `/api/tasks/[taskId]`,1.5s×2↑5s,`ASYNC_POLL_FALLBACK 32min`);
- ai-worker `handleVideoGenerate` 加 `chainMode` 分支(跳过 persistVideo 保 client-local + 跳过 shot 回写归 render_job G3);
- web 永不参与 ark 长等待,每组 HTTP 秒级,根治 reset。**向后兼容**:旧客户端 1.1.17 仍走同步 /api/generate/video(端点未删)不受影响。
- 运行时冒烟✅(2026-07-25):4928 chain 3 条 COMPLETED + ep1 重跑 8/8 全成,4945 ep1 重跑 12 组 1 失败组被 strict-skip 出片打破 11 连败。

**Live gotcha:** 单镜头生成**仍走同步 `/api/generate/video`**(大多 ark 2-3min<5min 不触发 reset);如果单镜头 prompt/参考图异常导致 ark >5min 仍会假死。chain 路径要 100% 防 reset 必须确保 client 1.1.18+(minVersion 0.0.0 软推,旧版本会走老同步路径)。

**Refs:** `packages/web/app/api/generate/video-async/route.ts`; `packages/web/app/api/generate/video/route.ts` (同步,单镜头保留); `packages/client/src/orchestrators/chain-generate.ts:684 (dispatchAndPollCloudVideo),838`; tag `20260724-chain-async`; [[dramaforge-chain-fakedead-hotfix-1117]] [[dramaforge-chain-refactor-single-shot]]

---

## chain 重派已完成组(轮询完成结果没持久化为 pass-through) [✅]

**Symptom:** 4945 重跑 chain 时 `input.groupResults` 12 条=2 复用(params===undefined 走 pass-through)+ 10 要生成,但 10 要生成的组里前 6(建场/推进/高潮/收束/过渡/尾声)被各生成 **3-4 次**、~22 task 全 COMPLETED 零失败,永远到不了 G3(shots 死活=5)。用户质问"完成的派个毛线啊"。

**Root cause:** chainCompile 被反复调用 ~4 次(每次 claim 只跑一次,跑完报 result/failed 走 /next 不自重跑→疑 render_job 被反复 re-claim/re-queue),每次重派要生成的组(因完成结果没持久化成 pass-through,`params` 还在)。`enqueueAiTask` 的 dedupe 原本只匹配活跃任务(PENDING/QUEUED/RUNNING),COMPLETED 直接跳过 → 重派的同 dedupeKey(`jobId:groupIndex`)被当成新任务再次生成。

**Rule / fix:** 改用更干净的服务端单点修法(tag `5127850`,2026-07-25):`enqueueAiTask`(`ai-task-repo.ts:131-141`)dedupe 的 dedupeKey 分支 SQL 加 `OR (status='COMPLETED' AND input->>'chainMode'='true')`,`ORDER BY (status='COMPLETED') DESC` 优先 COMPLETED。chain 重派时复用同 dedupeKey(`jobId:groupIndex`)的已完成 task(返回其 videoUrl,客户端 `dispatchAndPollCloudVideo` 本就轮询拿 url,零客户端改动)→ **已完成的组不再重生成**。作用域天然限 chainMode(图片用 `dedupeKey=revision.id` 但无 chainMode,保持活跃-only,"重新生成要新图"语义不变)。

**Live gotcha:** 复用的 COMPLETED task 的 videoUrl 若是 ark 原始 URL(chainMode 跳过 persistVideo),延迟很久的重跑可能 URL 过期 → downloadClips 失败 → 抛错报前端(可接受:用户重试新 job)。**未钉死**:chainCompile 为何被反复调 ~4 次(loop.ts 每次 claim 只跑一次,疑 render_job 反复 re-claim/re-queue,需客户端日志),但本修法不管触发点都管用(重派复用已完成)。

**Refs:** `packages/server/src/task/ai-task-repo.ts:131-141`; tag `5127850`; [[dramaforge-chain-refactor-single-shot]]

---

## ark 真人审核拒 → 转绘出片"脸直接没了" [⚠]

**Symptom:** 转绘项目出片时某角色(尤其群演)脸/画面"直接没了",前端无报错只转圈。

**Root cause:** 链路:客户端本地源帧(clips 目录) → 人物参考图网格处理(gridOverlay 保脸一致) → 调 ark 图生图风格化 → 拼成镜头(CHAIN_COMPILE) → 拼成片(CONCAT)。**人物参考图网格处理这步失败** → 触发安全门禁「人物参考图全部处理失败,已阻止无网格生成」→ 整组镜头直接不出片 → 用户看到该组角色脸/画面"直接没了"。网格处理失败三根因(查 `render_jobs.error`,按 user_id 过滤):
1. **ark 真人审核拦截(转绘必踩)**:`HTTP 400/422 InputImageSensitiveContentDetected.PrivacyInformation ... may contain real person`。转绘源本就是真人帧,ark 隐私审核必拒。
2. **客户端源帧 ENOENT**:`人物参考图稀疏网格处理失败...ENOENT ... C:\Users\<winuser>\AppData\Roaming\@dramaforge\client\clips\<uuid>.jpg`。换机器/清缓存丢本地源帧。
3. 放大因素:群演/配角 identityLock 常只有装备没五官(如保安 `["black tactical uniform","earpieces","muscular build","scar over eyebrow","combat boots"]`),零脸部特征 → 最依赖网格参考,网格一挂最先没脸。

**Rule / fix:** **未做代码根治**,严格说是开放问题。当前缓解:
- strict-aware partial 门禁(见上"CHAIN_COMPILE 整链 0 产出")让踩真人审核的组被跳过,其余组出部分片(打破"零产出");
- 4945 案例实证(2026-07-25):strict-skip 容掉 1 个踩真人审核的失败组,12 COMPLETED + 1 FAILED,链没整链挂、照常合片出成片,打破 11 连败。
- 待修方向:① 转绘走 ark 那条需「真人审核降级」(参考图风格化/模糊化预处理或换非 ark 图模型再重试);② 给群演补 identityLock 脸部特征降低网格依赖;③ 门禁 UX 透传 `PROVIDER_CONTENT_REJECTED` 成可读提示。

**Live gotcha:** 4945 类用户 chronic 失败=这个根因(非服务器快修)。**链串行渲染**(一次 1 镜,每镜 ark 3-8min,有时 15min),配了 6 路并发却没用 → 46 镜能拖几小时;并行可砍 5/6 时间,但组内可能有末帧依赖(跨组并行安全)。定位 SQL:`SELECT created_at,type,status,error FROM render_jobs WHERE user_id='<uid>' ORDER BY created_at DESC;` 关键词 `real person`/`ENOENT`/`已阻止无网格生成`。

**Refs:** (无代码修复点,tribal knowledge) `packages/client/src/orchestrators/chain-generate.ts` (网格处理 + identityLock 拼装); [[dramaforge-chain-compile-face-lost]] [[dramaforge-4945-chronic-chain-failures]]

---

## task-heal sweep 误杀长任务 → RUNNING 孤儿阈值按 type 分档 [✅]

**Symptom:** 健康长视频任务(ark 25min / EPISODE_SPLIT 30min)被 task-heal sweep 当 RUNNING 孤儿误杀,每 tick(60s)bump retryCount,18min(4 tick)后 retryCount(3)>=maxRetries(3) 假 FAILED;原 worker 仍跑到成功,markCompleted 的 CAS(status NOT IN COMPLETED,FAILED,CANCELLED)拒绝回写 → 用户看 FAILED 但 ARK key 已烧 + shots 已 COMPLETED(资损 + tasks/shots 状态分裂)。

**Root cause:** 曾经是单一 `STALE_RUNNING_MS=15min`,但 video handler 25min / EPISODE_SPLIT handler 30min 都 > 15min:健康长任务跑过 15min 即被 heal 当孤儿。

**Rule / fix:** `STALE_RUNNING_SECONDS_BY_TYPE` 按任务类型分档(`task-heal-sweep.ts:45-50`):`VIDEO_GENERATE=30min` (> handler 25min,ark pollAsync 内部 20min + 余量)、`EPISODE_SPLIT=35min` (> handler 30min,split + extract 各最长 15min DeepSeek 流式)、默认 12min(image ≤8min / text ≤3min / voice ≤5min + 余量)。`staleRunningSecondsForType(type)` 纯函数供单测。**每档必须严格 > 对应 handler 超时。**
**另外:retryCount 只对 RUNNING 孤儿递增**(真跑过卡死=真失败重试),QUEUED/PENDING 卡死多半是被 slot-gate 挡住(并发满 moveToDelayed 反复延迟)或 dispatch 入队失败——这些不是任务本身失败,重派幂等无副作用,不该消耗重试额度。旧实现无脑 bump,把被 slot-gate 反复延迟的健康任务推向 retryCount 耗尽误判 FAILED(生产 28 张资产图被误杀根因)。

**Live gotcha:** 加新 handler 类型必须同步加 `STALE_RUNNING_SECONDS_BY_TYPE` 条目,值 > handler 超时,否则被默认 12min 误杀。`processor.ts` 加新 timeoutForType 也要同步。

**Refs:** `packages/server/src/task/task-heal-sweep.ts:45-50,53-55,190-201`; `packages/server/src/ai-worker/processor.ts:98-105 (delayForRetry),177-183 (slot 拒绝走 moveToDelayed 不 fatal)`; [[dramaforge-fatality-audit-20260727]] [[dramaforge-chain-compile-billing-deadloop]]

---

## slot-gate TTL < 长任务 → 过并发加速 OOM [✅]

**Symptom:** 单用户并发计数器 Redis key TTL 到期时(count 归 0)用户可再 acquire 满 limit → 实际并发 = 2× limit(过并发),加速 Redis/服务器 OOM。

**Root cause:** 旧值 `SLOT_TTL_SECONDS=15min` < 长 video(25min)/ EPISODE_SPLIT(30min)任务时长 → 任务仍在跑时 key TTL 到期、count 归 0。

**Rule / fix:** `slot-gate.ts:41` 改 `SLOT_TTL_SECONDS=40min`(覆盖最长任务 + 余量)。崩溃泄漏的计数虽多存活 40min,但有 worker 启动重算(`recomputeAllFromDb`,Step1 重置孤儿 RUNNING→QUEUED + Step2 SCAN `concurrency:user:*` 清崩溃残留)+ task-heal sweep 双保险兜底。

**Live gotcha:** 上多 worker 前必须先按 `recomputeAllFromDb` 函数 JSDoc 的「多 worker 改造方向」改 Step1 的 WHERE 作用域(workerId 注册表+心跳)。**当前单 worker 部署**下 Step1 无条件重置所有 RUNNING 才安全;多 worker 滚动重启 / 多副本下 Worker B 启动会把 Worker A 正在跑的活任务也重置成 QUEUED → 双重执行。

**Refs:** `packages/server/src/domain/concurrency/slot-gate.ts:41,47,203-262 (recomputeAllFromDb)`; `packages/server/src/ai-worker/index.ts:168`; [[dramaforge-fatality-audit-20260727]]

---

## 运维干预 SQL 模式(止血卡死 render_job) [📦]

**Symptom / when to use:** 生产监视发现 CHAIN_COMPILE 假死(claimed 时长 >15min 且 result 空 且 心跳活,逃过 stalled/reap 自愈)时的手动止血。

**Rule / fix:** **首选** admin route `POST /api/admin/render-jobs/[id]/force-fail { reason }`(requireAdmin,立即生效 + 级联 + 退款 + SSE)。**web 不可用时**裸 SQL 兜底:
```sql
UPDATE render_jobs SET status='FAILED',
  error='[MANUAL-INTERVENE 日期] <一句话原因>',
  completed_at=now(), heartbeat_at=now()
WHERE id IN (...) AND status='RUNNING' RETURNING id,status,user_id;
```
- `AND status='RUNNING'` CAS 守卫不可省(防误改已终态正常任务);
- render_jobs 无 shotIds 列,shots 重置靠 G3-1 级联——裸 SQL 绕过级联,**必须**手动 `UPDATE shots SET "videoStatus"='FAILED' WHERE "projectId"=... AND "videoStatus"='GENERATING'`,或等 `sweepStuckShots` 下一 tick(60s)兜底;
- DB 改 status 不通知客户端停,客户端 Electron 或成孤儿继续跑(次要,止血目标是前端 UX 停转圈);
- 用户口语"4928"是**手机号末四位**(`users.phone LIKE '%4928'`),查 render_jobs/tasks 先要 phone→UUID(`users.id` 是 text(UUID),`render_jobs.user_id` 也是 UUID)。

**Live gotcha:** forceFail admin route 已上线后,**裸 SQL 不再是首选**——用它推完必须手动级联 shots,漏一步镜头永久卡 GENERATING(见上"运维裸 SQL UPDATE 绕过 G3-1 级联")。`scripts/kill-render-job.sh`(记忆中提到的运维脚本)在当前 repo **未找到**,疑似从未 commit 或已删——以 admin route 为准。

**Refs:** `packages/web/app/api/admin/render-jobs/[id]/force-fail/route.ts`; `packages/server/src/task/render-job-repo.ts:1247-1286 (forceFail)`; [[dramaforge-chain-fakedead-hotfix-1117]] [[dramaforge-manual-intervene-shots-stuck]]

---

## 进度回写延迟到链完成(非断) [📦]

**Symptom:** 4945 等 chain 用户跑 ep1 时进度卡在上次完成态(03:08),整链跑 ~62min 里 shots 不动,完成瞬间才批量更新。曾误判为"进度回写断了"。

**Root cause:** chainMode 逐镜跳过 shot 回写(client `chain-generate.ts:776` 附近),归 CHAIN_COMPILE G3 级联在链 COMPLETED 时**批量回写所有 shots**(实测 aa115a98 完成于 04:10:08,24 个 ep1 shot **同秒**被写成 COMPLETED+currentMaterialUrl)。是增量反馈缺失的 UX 问题(长链全程无 per-shot 进度),非数据 bug。

**Rule / fix:** 这是 chain 设计(并非 bug)——G3 完成时批量回写已确认生效(`render-job-repo.ts:326/450` SET currentMaterialUrl+COMPLETED)。**渐进回传**作为 dramaforge 独建增强(每组视频即时显示)已在另外的 issue 跟踪,非本文件范围。

**Live gotcha:** 用户报"进度卡了"时,先确认是 chain 链跑中(G3 完成时才批量回写)而非真断;查 render_jobs 状态 + 心跳即可区分。

**Refs:** `packages/server/src/task/render-job-repo.ts:465-535 (persistChainShotGroups 批量回写)`; [[dramaforge-4945-chronic-chain-failures]] [[dramaforge-progressive-group-delivery]]

---

## chain-generate 分镜不存在 → 500 未处理异常 [⚠]

**Symptom:** 2026-08-01 巡检(web image 2155da4)30min 窗口捕捉 `[handleApiError] [POST /api/projects/[id]/episodes/[episodeId]/chain-generate] 未处理的异常: { message: '分镜不存在' }`。episode 无分镜(或分镜被删)时点链式生成,接口 500,前端只见通用错误。

**Root cause:** chain-generate route 分镜存在性校验以 `throw new Error('分镜不存在')` 抛普通异常,handleApiError 兜底成 500;客户端生成入口无前置校验/禁用。

**Rule / fix:** route 改显式 400 业务错误 + 友好 message(或复用既有业务错误类);客户端无分镜时禁用生成按钮并提示。低频用户操作错误、无数据损失、不阻断其他用户——P3 排队变更窗口。

**Live gotcha:** 复现 = 打开 episode → 无分镜 → 点链式生成。证据时间 2026-08-01 ~11:0x CST。同类 `throw new Error('…')` 前置校验如散见 chain 相关 route,顺带 grep 收敛。

**Refs:** `packages/web/app/api/projects/[id]/episodes/[episodeId]/chain-generate/route.ts`(与 continuity-prompt.md 的 status 门 `:552/:563` 同文件)
