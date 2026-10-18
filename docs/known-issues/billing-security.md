# 计费 / 安全 / Provider 约束 (Known Issues)
> 从 Claude 记忆合并 2026-07-27。Liveness: ✅current · ⚠stale · 📦historical · 🔒被hook/CI强制(若适用)
>
> 核验基线：D:\dramaforge-cs 工作树（HEAD = 2026-07-27）。每条标注的 `file:line` 已对照当前代码确认存活。

---

## F1 计费ID错位 (job.id vs task_id) [✅]
**Symptom:** 链路失败时"扣得到退不到"；FAILED/CANCELLED 终态后仍能扣到迟到结算（资损）。
**Root cause:** `chargeAggregatedTaskCost` 把 `render_jobs.task_id` 写进 `billing_ledger.taskId`，但退款三路由传 `render_jobs.id`（主键），终态门 `WHERE id = $1` 也查主键 → 两边永远对不上：退款 SELECT 找不到 TASK_DEBIT，409 终态门 `renderStatus` 恒 undefined。
**Rule/fix:**
- `service.ts:chargeAggregatedTaskCost` 终态门改 `WHERE task_id = $1 AND user_id = $2`（原 `WHERE id`）。
- 退款三路由 `failed` / `result` / `admin/force-fail` 把 `transition.job.id` → `transition.job.taskId`（force-fail 是 `r.job.taskId`）。
**Live gotcha:** `render_jobs.id`（genId 主键）与 `render_jobs.task_id`（chain-generate route 派发的 billingTaskId）是两个不同的字符串，永远不相等。新写计费/退款逻辑前先去 `service.ts:280-282` 看那段大段注释（"若按主键 id 查永远查不到 → renderStatus 恒 undefined"）。
**Refs:** `packages/server/src/domain/billing/service.ts:275-287` (WHERE task_id + 警示注释)；`packages/web/app/api/render/jobs/[id]/failed/route.ts:65-67`；`packages/web/app/api/render/jobs/[id]/result/route.ts:98-101`；`packages/web/app/api/admin/render-jobs/[id]/force-fail/route.ts:48-52` · [[dramaforge-fatality-audit-20260727]] · [[dramaforge-chain-compile-billing-deadloop]]

---

## F2 task-heal STALE_RUNNING 误杀长任务 [✅]
**Symptom:** 健康长任务跑 18min 就被标 FAILED；handler 跑完 markCompleted 被 CAS 拒绝 → 用户看到失败但 key 已烧、shots 已 COMPLETED。
**Root cause:** 旧 `STALE_RUNNING_MS=15min` 单值无视 type，而 video handler 25min / EPISODE_SPLIT handler 30min；`findStuck` 用 `startedAt`（一次性，不刷新）做窗口 → 长任务在第 4 个 60s tick 后 `retryCount>=3` 假 FAILED。
**Rule/fix:** 新导出纯函数 `staleRunningSecondsForType(type)` 分档：`VIDEO_GENERATE:30min`（>25min handler）/ `EPISODE_SPLIT:35min`（>30min）/ 默认 12min；`findStuck` SQL 用 `CASE WHEN type=... THEN ... ELSE default`。
**Live gotcha:** 加新 job type 时若 handler >12min 必须显式在 `staleRunningSecondsForType` 注册新档位，否则会被默认 12min 误杀。
**Refs:** `packages/server/src/task/task-heal-sweep.ts:38-58` (注释 + VIDEO_GENERATE:30/EPISODE_SPLIT:35) · [[dramaforge-fatality-audit-20260727]]

---

## F3 LONG_VIDEO_REWRITE 超 4h claim 回收（默认档 20min→4h） [✅]
**Symptom:** LONG_VIDEO_REWRITE 编排跑 1-6h，多设备/重启时 `claimNext` 把活 job 当 stale 回收 → 原 client 409 abort → in-flight LLM 调用丢失（最坏 ~50min Kimi chat 损失）。
**Root cause:** `MAX_CLAIM_DURATION_SECONDS=20min` 单值无视 type；且 20min 默认档也会误杀 strict 一键出片的长 chain（30-60min+ 属合法执行）。
**Rule/fix:** 新 `MAX_CLAIM_DURATION_SECONDS_BY_TYPE` map：`LONG_VIDEO_REWRITE:12h`，其他走默认 4h；纯函数 `maxClaimDurationSecondsForType(type)`；`claimNext` SQL `CASE WHEN type='LONG_VIDEO_REWRITE' THEN 43200 ELSE 14400 END`。
**Live gotcha:** LONG_VIDEO_REWRITE 走 `render_jobs` 表（`dispatch.ts:133`），**不是** BullMQ `tasks` 表；别把它当成普通 BullMQ 任务调短超时。`render_jobs` 与 `tasks` 是两套 schema（snake_case vs camelCase），别混。
**Refs:** `packages/server/src/task/render-job-repo.ts:120,132-137,813-814,1083-1084` · [[dramaforge-fatality-audit-20260727]] · [[dramaforge-render-job-fakedeath-fix]]

---

## slot-gate SLOT_TTL_SECONDS 15min→40min [✅]
**Symptom:** 长任务（EPISODE_SPLIT 30min）跑着时 Redis key TTL 到期 → count 归 0 → 用户再 acquire 满 limit → 2× 过并发，加速 OOM。
**Root cause:** TTL 15min < EPISODE_SPLIT handler 30min。
**Rule/fix:** `SLOT_TTL_SECONDS = 40 * 60`（2400s，>35min staleRunning + 余量）；每次 `acquireSlot`/续租都 `redis.expire(key, SLOT_TTL_SECONDS)`。
**Live gotcha:** INCR 部分成功仍可能泄漏（若 INCR 成功后 expire 失败），根解要 Lua 原子化（deferred）；当前 TTL+`recomputeAllFromDb` 兜底够用但不是数学上的原子。
**Refs:** `packages/server/src/domain/concurrency/slot-gate.ts:41,109,255` · [[dramaforge-fatality-audit-20260727]]

---

## processor.ts OOM/infra 异常当 fatal [✅]
**Symptom:** Redis OOM（noeviction 拒写）使 `acquireSlot` INCR 抛 OOM error → 上抛到 `worker.on('failed')` → markFailed。瞬时峰值本应重试却判死。生产曾 41 次 VIDEO_GENERATE 假死（07-24 一次性，13:08 后零复发）。
**Root cause:** `getConcurrencyLimit` + `acquireSlot` 在 try 外，Redis OOM 走 uncaught path。
**Rule/fix:** 抽 `delayForRetry(job,token,reason):Promise<never>`（`moveToDelayed` 5s + throw `DelayedError`，降级 throw Error）；步骤1 用 `let slot!:...; try{limit+acquireSlot}catch(infraErr){delayForRetry}` 把 infra 异常（Redis OOM / ECONNRESET / DB hiccup）兜进与"并发满"同款重试路径，不消耗 attempt。
**Live gotcha:** `DelayedError` 不消耗 attempt，Redis 长期满会每 5s 重投（死循环顾虑）；backstop = task `timeoutAt` + task-heal。瞬时峰值恢复即成功，可接受。**不要把 DelayedError 当 fatal 上报到 markFailed**。
**Refs:** `packages/server/src/ai-worker/processor.ts:46,96-108,161-183` · [[dramaforge-video-gen-failure-breakdown]] · [[dramaforge-render-job-fakedeath-fix]]

---

## Redis maxmemory 256mb→384mb [✅]
**Symptom:** 256mb 在 07-24 部署密集期被队列峰值打满 → noeviction 拒写 → 41 次 OOM 假死（见上）。
**Rule/fix:** docker-compose `redis.command` 加 `--maxmemory 384mb`（保留 256→384 的提交注释，引用"61 次"历史）。`mem_limit 512m` 不动。
**Live gotcha:** **不要**调到 512mb 与 container `mem_limit` 撞顶 → Redis 进程 + AOF 开销会触发 cgroup OOM-kill（比 noeviction 拒写更糟，连进程都死）。384mb 是有意的，留 128mb 给 Redis 开销。代码侧（processor.ts）才是真根治。
**Refs:** `docker-compose.yml:67-95` (redis service, maxmemory 384mb) · [[dramaforge-video-gen-failure-breakdown]]

---

## PG连接池 max=80×3 > 100 [✅]
**Symptom:** 旧 `infra/pg.ts:49` 硬编码 `max: 80`，web/ai-worker/migrate 三进程 ×80 = 240，远超 `pg max_connections=100`，连接风暴触发 `too many connections` 级联。实测峰值才 39 连接，40× 过度。
**Rule/fix:** `infra/pg.ts` 改 `max: env().PG_POOL_MAX`（env.ts 默认 10）；docker-compose 给 web `PG_POOL_MAX:"10"`、ai-worker `PG_POOL_MAX:"5"`。
**Live gotcha:** 新加进程若直连 PG 必须传 `PG_POOL_MAX`，不要用 pg 节点模块默认值（10/node 进程，多进程仍可能超）。生产连接数预算 ≈ Σ PG_POOL_MAX × 进程数。
**Refs:** `packages/server/src/infra/pg.ts:49`；`packages/server/src/infra/env.ts:114` (PG_POOL_MAX default 10)；`docker-compose.yml:178,215` (web 10 / ai-worker 5) · [[dramaforge-security-audit-20260722]]

---

## Docker 日志无 rotation [✅]
**Symptom:** json-file 默认无上限，日志无限增长 → 磁盘满 → pg WAL 写不进 → recovery loop（历史 P0）。
**Rule/fix:** docker-compose 顶层 `x-logging: &default-logging`（driver=json-file, max-size=10m, max-file=3），6 服务全 `logging: *default-logging`。每容器封顶 30MB。
**Live gotcha:** 加新 service 必须加 `logging: *default-logging`，否则该服务无限增长。
**Refs:** `docker-compose.yml:27-31,45,73,108,134,163,201` · [[dramaforge-security-audit-20260722]]

---

## 3000 端口绑 0.0.0.0 [✅]
**Symptom:** 公网能直连 web:3000 绕过 nginx 的 TLS / 限流 / 安全 header。
**Rule/fix:** `ports: - "127.0.0.1:${WEB_PORT:-3000}:3000"`（loopback）。用户初报"还能打开界面"=浏览器缓存。
**Live gotcha:** 加新对外服务时记得绑 `127.0.0.1:` 前缀，nginx 反代到此。
**Refs:** `docker-compose.yml:180` · [[dramaforge-security-audit-20260722]]

---

## 客户端更新链 Ed25519 签名 [⚠]
**Symptom:** 服务器沦陷（推毒 manifest + .exe）= 全量客户端 RCE。此前 updater 裸下载 .exe 直接 spawn 安装，零校验。
**Rule/fix:**
- **信任模型**：Ed25519 非对称签名（`node:crypto` 原生，零依赖）。私钥离线保管永不进服务器/git；公钥 SPKI DER base64 硬编码进 `packages/client/main/index.ts` 的 `UPDATE_SIGNING_PUBLIC_KEY`。
- **fail-closed**：有 publicKey 时签名错/缺/sha256 不符均删缓存拒绝（返 `signature-failed`）；publicKey 空 = dev 跳过（`console.warn`）。
- **shared/web**：`client-api.ts` 的 UpdateCheckResponse/HeartbeatResponse 加 `signature+sha256`；web `lib/versions.ts` 加同字段 + SAFE_DEFAULT 补空串；`app/api/client/{update,heartbeat}/route.ts` 返字段。
- **scripts**：`gen-update-key.mjs`（离线生成密钥对）+ `sign-client.mjs`（.exe 算 sign(sha256)）+ `publish-client.sh <version> <私钥路径> [--force]`。
**Live gotcha:** **⚠ 当前 `UPDATE_SIGNING_PUBLIC_KEY = ''`（main/index.ts:80），生产仍是 dev-skip 状态**。阶段2 待用户离线步骤：(1) `node scripts/gen-update-key.mjs ~/dramaforge-update-ed25519.pem` → 公钥 + 私钥；(2) 公钥贴进 `UPDATE_SIGNING_PUBLIC_KEY`；(3) `pnpm --filter @dramaforge/client package` 打包验签版；(4) `bash scripts/publish-client.sh <ver> <key> --force` 强制收敛到验签版。**信任建立窗口**：第一个验签版经无验签通道下发（缓解：离线机打包签名 + publish 时服务器干净）。阶段1（web 镜像 tag 5f6119f）已部署，curl `/api/client/update` 返 `signature:""` `sha256:""` 向后兼容旧客户端。
**Refs:** `packages/client/src/ops/updater/updater.ts:40-112,204-205` (verifyUpdatePackage)；`packages/client/main/index.ts:76-80,331` (UPDATE_SIGNING_PUBLIC_KEY='' + publicKey)；`packages/shared/src/client-api.ts`；`packages/web/lib/versions.ts`；`packages/web/app/api/client/{update,heartbeat}/route.ts`；`scripts/gen-update-key.mjs`、`scripts/sign-client.mjs`、`scripts/publish-client.sh` · [[dramaforge-update-signing-chain]] · [[dramaforge-security-audit-20260722]] · [[dramaforge-fatality-audit-20260727]]

---

## Seedance reference_audio 总时长 ≤15s (每条裁 5s) [✅]
**Symptom:** 多角色镜头把 3 条预置音色（如 3.6+4.96+9.12=17.68s）塞进一次 Seedance 请求 → `InvalidParameter: audio total duration must be ≤ 15`。单条 max 11.6s 永远合法，**唯一能超 15s 的是多条求和**。
**Root cause:** dramaforge + app1 都只在收集点卡**数量** `MAX_REFERENCE_AUDIOS=3`，**无总时长控制**。ark.ts 把多条 audio_url 拼同一 content 一次 POST。app1 同 bug、无可照搬。
**Rule/fix:** 客户端在唯一字节→data-URL chokepoint `applyReferenceAudioFiles`（`chain-generate.ts`）每条裁到 5s（3×5=15s 卡上限）：
- 新 `trimAudio(src,maxSec,out,signal?)`（`src/ffmpeg/ffmpeg-pipeline.ts`，`argv ['-i',src,'-t',maxSec,'-c','copy','-y',out]`，`-c copy` 对 PCM wav 采样级精确）。
- 新 `readPresetVoiceTrimmed(file,voicesDir,maxSec?)`（`main/voice-store.ts`，复用 readPresetVoice 三层校验 + manifest dur；dur>maxSec 则 trimAudio 到 `os.tmpdir()`，永不 throw）。
- `applyReferenceAudioFiles` 用 `readPresetVoiceTrimmed(file,ctx.voicesDir,REFERENCE_AUDIO_MAX_SEC=5)`，服务端不动。
**Live gotcha:** 服务端零变更（收集点/数量上限/ark.ts 全不动），**只改客户端**。发版见 client 1.1.15。⚠ 3×5.0=15.0 临界：wav `-c copy` 采样级精确故每条严格 ≤5.0；若实测 Seedance 对 15.0 敏感降到 4.9。**同样规则适用参考视频**（文档同节），dramaforge 链式生成不发多参考视频故不涉及。
**Refs:** `packages/client/src/orchestrators/chain-generate.ts:74,409-426` (readPresetVoiceTrimmed + REFERENCE_AUDIO_MAX_SEC=5)；`packages/client/src/ffmpeg/ffmpeg-pipeline.ts:362-393` (trimAudio)；`packages/client/main/voice-store.ts:27,224-306` (readPresetVoiceTrimmed) · [[dramaforge-seedance-ref-audio-15s-cap]]

---

## 备份脚本 / .env权限 / root密码 / fail2ban [🔒]
> **不在仓库受控**，是 `/opt/dramaforge/` 服务器运维层。仅在此登记 known-issue 不接管。git ls-files 验证 `.env`/`backup.sh`/`fail2ban` 配置都不在 tracked 集合。

- **备份脚本容器名失效**（2026-07-22 P0-1）：`/opt/dramaforge/backup.sh` 调旧名 `sf-postgres`/`sf-redis`，1.1.4 改名后变 `dramaforge-postgres`/`dramaforge-redis`；docker exec 失败被 gzip 吞掉，`set -e` 没拦住照样 echo "backup done"。最近有效 DB 备份曾回退到 7/19。修法：改名 + `set -euo pipefail` + 产物大小校验 + 失败 exit1。⚠ 仓库 scripts/ 无 backup.sh，需 SSH 进 `/opt/dramaforge/`。
- **`.env` 644 全局可读**（2026-07-22 P0-4）：`/opt/dramaforge/.env` 含支付宝私钥 `ALIPAY_APP_PRIVATE_KEY` + DEEPSEEK/ARK/KIMI key + SMS secret + PG/REDIS 密码 + `NEXTAUTH_SECRET`。修：`chmod 600`；与 `/root/dramaforge-prod.env` 重复删一份。仓库 `.env` 已被 `.gitignore` 屏蔽，但仍是本地明文。
- **`/root/.root-pass` 明文**（2026-07-22 P0-5）：25 字节存 root 密码。删掉（sshd 已禁密码登录）。
- **fail2ban / 主机防火墙**：服务器无主机防火墙 INPUT ACCEPT 全靠阿里云安全组；fail2ban 是 SSH key-only 之外的二层防御（iptables banaction，非 firewalld）。仓库 `scripts/dramaforge-secmon.sh` 只监控失败 SSH 数（"fail2ban 应已拦"），不管理 fail2ban 配置。
**Live gotcha:** 这些都不在 git 里改，是 SSH 进 `YOUR_SERVER` 改 `/opt/dramaforge/` 下文件。代码 PR 不会触及；**部署/迁移时记得同步检查**。
**Refs:** `scripts/dramaforge-secmon.sh:33`（fail2ban 监控引用，仓库内唯一 touchpoint）；其他全部在服务器 `/opt/dramaforge/` 外 · [[dramaforge-security-audit-20260722]] · [[dramaforge-server-security-hardening]] · [[dramaforge-deploy-ops]]

---

## 📦 Deferred 未修（参考性登记）

下列在源记忆里就被标 deferred，**当前代码无修复**，登记此处仅为可见性；不再展开：

- **docker 总内存 2304m > 主机 1.8GB**：web768+worker256+pg512+redis512+minio256，靠 6GB swap 兜底。根解加 RAM 至 4GB；代码侧 `generate/text` route + `handlers.ts:persistVideo` 两处 `arrayBuffer()` 灌 RAM 未做流式（P1，video-to-script 已有 `req.body` 流式基础设施未跟进）。
- **AR>2.50 参考图无前置尺寸校验**（07-25/26 真信号）：8 次 07-25 10:01 同一 chain 8 镜，同一张过宽参考图（AR=3.04）被 Seedance 拒。需单独查哪类参考图产出 AR>2.5（scene-blocking 已排除，未部署）。**当前真阻断另开线**。
- **slot-gate INCR 部分成功泄漏**：`acquireSlot` 用 INCR + EXPIRE 两步，理论上 INCR 成功后 EXPIRE 失败会泄漏计数。Lua 原子化可彻底解，当前 TTL 40min + recomputeAllFromDb 兜底。
- **chain-generate route 内 LLM 重写无超时**：seedance-narrative-rewrite `callAI` 不传 signal。
- **aggregate 多组失败只留首笔 PENDING_DEBIT 漏收**：`unique(userId,taskId,type)` duplicate 模式下，同 taskId 多组失败只成一笔 PENDING_DEBIT；修 F1 后需产品决策"failed_validation 全退 vs 按比例退"。
- **Kimi chat 5×10min=51min 重试放大 / long-video-text 双 provider 81min**：LLM 上游超时放大未做统管。
**Refs:** [[dramaforge-fatality-audit-20260727]] · [[dramaforge-video-gen-failure-breakdown]]

---

## 剔除的误报（写源记忆时已 spot-check 否决，不再追）

- ~~middleware 改名 proxy.ts 失效~~：Next 16 官方正确写法（15.2+ 改名，提供 codemod），CSRF 逻辑已编译进 prod chunk。**勿改回 middleware.ts**。
- ~~cancel 轮询泄漏~~：轮询在 `acquireSlot` 门控后才启动，`delayForRetry` throw 在轮询前退出，轮询不会启动。
- ~~补扣 sweep 缺失~~：sweep 在 `ai-worker/index.ts:187` 跑（pendingCharge + PENDING_DEBIT 双 sweep）。
