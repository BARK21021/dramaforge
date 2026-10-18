# dramaforge C/S 重构状态历史 (System of Record)

> 从 Claude 记忆迁出 2026-07-27。这是 dramaforge C/S 重构的过程状态历史（append-only）。最新在最前。
>
> **设计与计划**见 [`superpowers/specs/2026-07-18-cs-refactor-design.md`](superpowers/specs/2026-07-18-cs-refactor-design.md)（15 模块/3 运维骨架/render-job 契约/任务归属）+ [`superpowers/plans/2026-07-18-cs-refactor.md`](superpowers/plans/2026-07-18-cs-refactor.md)（7 批/Task 0-13）。
> **硬约束 H1/H2/H3 + app1 迁移政策**见 [`known-issues/architecture-and-migration.md`](known-issues/architecture-and-migration.md)。
> **后续 UI 复刻路线**见 [`REPLICATE-APP1-PLAN.md`](REPLICATE-APP1-PLAN.md)；**云端部署历史**见 [`deploy-history.md`](deploy-history.md)。
>
> 编辑说明：正文逐字迁自 Claude 记忆 `dramaforge-cs-refactor.md`（frontmatter + 项目摘要未迁，保留在记忆薄指针里）。续号保留原编号（含天然缺口 10/14/15，早年已剪）。本文件覆盖 2026-07-18 侦察期 → 2026-07-19 P0-P7.1 垂直薄片期；之后的链路改造/部署历史去 `deploy-history.md` + 各 `known-issues/*`。

---

## 续20 (2026-07-19 晚) ✅ P7.1 分集地基 done + 支付宝 key 上服务器 + 部署态澄清

续19。P6 后用户「你来继续」→ 最后一块功能差距「分镜体系对齐」(app1 工作台 UI 11,338 行)。**recon 颠覆性发现**：episodes/asset/shot 表 + asset/shot domain 全 CRUD + workflow 9 步定义**早就在 dramaforge**（大 C/S 重构遗留）→ P7 **非 greenfield、零迁移**，缺的是 episodes domain + 编排路由 + 工作台 UI。拆 5 切片（P7.1 地基→P7.2 编剧分析→P7.3 资产生成→P7.4 分镜生成→P7.5 生产集成），本 slice 做 P7.1。plan `docs/superpowers/plans/2026-07-19-cs-ui-vertical-slice-p7-1-episodes.md`。

**T1** `shared/episode.ts`(EpisodeRecord/枚举/create+update+reorder schema) + `server/domain/episode/{service,validation,index}`(listByProject/create 自动 episodeNumber/getById/update 白名单+**stageStatus 单调推进**防回退/remove **shots FK 级联自动清**/reorder) + 19 状态化 mock 测试。**T2** project 补 getById+update(工作台按 id 加载/重命名)+6 测试。**T3** web 路由 GET/PATCH `/api/projects/[id]`+GET/POST `/api/projects/[id]/episodes`(+`?reorder=1`)+GET/PATCH/DELETE `.../episodes/[episodeId]`，每路由 requireUser+ownership(统一 404 不泄露)+zod，+19 测试。**T4** UI `workspace/[projectId]/page.tsx` 外壳+`EpisodeListStage`(建/编辑 Modal/删二次确认/↑↓排序/贴 novelText)，视觉对齐 app1 像素非 gate(用户测试机 QA，dramaforge web 无 jsdom/RTL 不测 React 组件同 P3/P4)。

**两坑**：① update NOW() 写参数化字符串 'NOW()' pg 转 TIMESTAMPTZ 失败→改字面内联；② domain barrel `export * from './episode'` 裸 `create` 撞 project(TS2308)→去掉留 `export * as episode`，mapRow 私有(同 P6 修复)。gate 全绿：server typecheck0+**436**(+25)/web typecheck0+**157**(+19)+next build 绿(`/workspace/[projectId]`+3 episodes 路由编译)/client typecheck0+128。

**支付宝 key 已上服务器**：用户指 F:\app1 有真·生产三密钥(我原先误问用户)，写 `C:/Users/<user>\dramaforge_alipay_push.sh`(无密钥值/动态读 app1/幂等)用户 `!` 跑，落 `/opt/dramaforge/.env`(6 行，URL 改 your-domain.example.com 根，nginx 验证)。

**部署态澄清**(写进 `dramaforge-cloud-deploy-state`)：客户端更新通道**现在断的**(client-releases 有 0.0.0+1.0.0 旧 .exe 但 manifest.json 丢失→`/downloads/manifest.json` 404，且 heartbeat 是 dramaforge 专有 app1 当班 404 cutover 后才通)；服务器 dramaforge DB 未迁移最新但**自愈**(migrate 启动补+cutover 灌数据)。用户「做完和我说，到时候用另一台电脑测客户端」→ 自主跑完 P7.1。

**下一步**：P7.2 编剧分析(analyze-script AI + STORY_ANALYZE taskType，需先验 ai-worker handler 真实现否)。cutover #87 仍卡用户明确授权。

---

## 续19 (2026-07-19 晚) ✅✅ P6 支付宝电脑网站支付移植 done + Task #36 闭环

续18。用户问"支付宝呢"→ recon **关键纠错**：D:\app1 是 **07-10 过时副本**（贴二维码+管理员人工充值土法，无真在线支付）；**F:\app1 才是活的**（07-14~17 admin-console worktree 期间已做完真·支付宝 page.pay）。之前"搬土法"推荐基于过时副本是错的，用户指 F:\app1 后校正。P6=把 F:\app1 已批准已测试真在线支付（page.pay 跳收银台+trade.query 轮询到账+notify 异步回调验签+订单状态机幂等）**架构映射**移植到 dramaforge（非发明，app1 07-14 spec/plan/test 全在）。plan `docs/superpowers/plans/2026-07-19-dramaforge-alipay-payment-port.md`(基线 `477da19`) → 7 task 全自写（子 agent 仍 429）合一提交 `7850618`+worklog `327f2f5`。

映射：app1 Prisma→dramaforge 手写 pg `payment-order-repo`(镜像 render-job-repo)；`@core/*`→`@dramaforge/*` barrel(src/index NAMED re-export)；app1 `billing.credit`→dramaforge 新增 `billing.creditPurchase`(type=PURCHASE_CREDIT，镜像 creditRefund)；app1 `electronAPI.openExternal`→dramaforge `sfShell.openExternal`(补 IPC channel+bridge 方法+main handler 带 **http(s) 安全校验**防 renderer 被攻陷开 file://)。

**幂等核心**：`claimPaid` 原子 `UPDATE WHERE status='PENDING' RETURNING *`(count=1 才发)+billing 不为 PURCHASE_CREDIT 加防重放索引(状态机已是单一来源)。新增：server `domain/payment/{client,service,rules,types,repo,index}.ts`+单测 13+5(穿透 repo 真实 SQL 验状态机幂等)+`0002-payment-orders.sql`(snake_case 新表,2 索引)；web 4 路由(orders 建/`[id]`/status 轮询/notify 回调+`/api/user/balance` 新建)+`/payment/return`(Suspense+轮询,Next16)+`Modal`(极简无 Radix)+`PlatformRechargeModal`(sfShell.openExternal)+`CreditsBadge`(原生 fetch 轮询,挂 workspace 页头)。

决策：payment_orders **不迁数据**(billing_ledger 已带积分历史)；三密钥 env optional(缺则 config-guard 抛 500)→ 真 E2E 待支付宝 key；rate-limit TODO 降级(dramaforge 无基建)；CHAIN_COMPILE 输出改本地仍 deferred(无 UI)。坑：domain barrel `export *` 时 payment.mapRow 撞 project.mapRow(TS2308)→ mapRow 移出公共 barrel。gate 全绿：server 417/web 138+**next build 绿**(全 P6 路由编译)+client 128 test；本地 next build 首跑因无 env 在 page-data collection 触发 env() 校验失败(**非代码缺陷**,Dockerfile builder 阶段给占位 ENV 解决)。commits **477da19..327f2f5**。

**支付宝移植结构达成** ✅。真 E2E=用户提供支付宝 APPID/私钥/公钥→写服务器 dramaforge `.env`(GC-1)→cutover 上云→桌面客户端 workspace 点充值→跳支付宝→付完轮询到账→余额增加。

**下一步**：① cutover dramaforge 上云(#87 仍卡用户明确授权；P6 已进代码,cutover 时 web 镜像重建带 P6)；② 用户提供支付宝 key 做真 E2E；③ CHAIN_COMPILE 输出改本地。

**⚠️app1 活的在 F:\app1 非 D:\app1**(D: 是过时副本)，见 `app1-cloud-deploy-direction` 纠错。
> 注：此纠错为 2026-07-19 时序观察；后续 app1 活副本回到 D:\app1（git 07-21 最新），见记忆 `app1-cloud-deploy-direction`。本段保留作历史。

---

## 续18 (2026-07-19 晚) ✅✅✅ C/S 垂直薄片 P5 合片成品落客户端本地 done + CP2[=P4-P5]结构达成

续17。P4 后用户「继续」→ P5。**子 agent 429 余额不足，本阶段全自写无 subagent**（靠 typecheck+test+build+opus whole-branch 审查兜底）。recon 发现合片 pipeline 整条早建好（`/api/render/dispatch`→render_jobs 表→client render-worker loop/executor/uploader→HTTP 拉 `/next`→ffmpeg→报 `/result`/`/progress`/`/failed`→SSE `/api/sse` Redis `task:events`），真冲突是成品原**全程 MinIO**（dispatch 签 `renders/<userId>/<jobId>.mp4` presigned PUT→uploader 上传→result 带 outputKey→presign-GET 播）违 `dramaforge-assets-client-local`。

plan `docs/superpowers/plans/2026-07-19-cs-ui-vertical-slice-p5.md`(基线 `10f1a26`) → 2 task + 1 review-fix 全自写 + whole-branch opus **Approved（Yes-with-followups）**：

**TaskA**(server+client `ab6c480`) CONCAT 成品 MinIO→客户端本地——`dispatchFilmExport` 删 presignUpload/outputKey（删 getStorage import）→executor CONCAT 写 `userData/clips/<jobId>.mp4`（ExecuteJobDeps 增 filmsDir+toAssetUrl 注入）+ 返 `{outputUrl:sf-asset://, meta:{localKey}}`（删 uploadArtifact）→loop/main 注入 filmsDir=clipsDirFrom+toAssetUrl=resolveClipUrl（复用 P4 协议/目录，零新机制）；CHAIN_COMPILE 输出改本地 **DEFERRED**（chain-generate.ts TODO，无 UI 触发，无 URL 时 type 边界即拒）。

**TaskB**(web `5d67c97`) 新 `/compile` 页——`compile-flow.ts` 两纯函数 `dispatchCompile`(POST FILM_EXPORT→taskId,永不reject)+`matchCompileEvent`(SSE 事件→done/failed/null)+`page.tsx`(useSession 门+clip URL Textarea→**先订阅 SSE 再派发**(I2 fix 防 COMPLETED 丢)→按 taskId 匹配→Electron `<video sf-asset://>`/浏览器提示需桌面客户端；onerror 即时 toast+URL http(s) 校验)；dispatch 路由返 `{renderJobId, taskId}`(taskId 供 SSE 关联)+projectId Zod optional（render_jobs 表无 project_id 列）。

**review-fix**(`56d8427`)：opus 独立核三约束源码级 clean，修 I2(SSE 订阅先于派发)+M1(3 处过期注释)+M2(onerror)+M3(URL 校验)+M6(措辞)；Leave I1(ChainCompileInput.outputUploadUrl 留必填,plan 偏差可辩护)/M4(durationSec UI 未发)/M5(vestige 清理)。

gate 全绿：server 399/client 127/web 138 test，typecheck×3 clean，web build 绿 `/compile` 进路由。commits **10f1a26..56d8427**(5：4d708af plan/5f06119 worklog17/ab6c480 TA/5d67c97 TB/56d8427 fixes)。**CP2[=P4-P5]结构达成** ✅。

**关键纠正（vs 续17 误述）**：ARK key 是**平台云端服务器**的（已在服务器 .env，非用户自有，见 `dramaforge-keys-cloud-server-only`）→ 真生成/合片 E2E 只在 **cutover 上云**后；**app1 现仍生产在跑**（dramaforge 备好未运行，1.8GB 不可 side-by-side，见 `dramaforge-cloud-deploy-state`）。

**下一步**：cutover dramaforge 上云验真 E2E（需 app1 无真实用户或接受生产降级）→ Alipay 移植(#36) → app1 分镜体系对齐(CP2 之后)。

---

## 续17 (2026-07-19) ✅✅ C/S 垂直薄片 P4 AI 视频生成 done + CP2 第一块结构达成

续16。P3 后用户「继续」→ P4。**两条用户新硬约束（本阶段落地，已写记忆）**：① **资产客户端本地**——所有媒体只存 Electron 客户端本地硬盘，服务器（含 MinIO）不存任何视频字节（推翻 brainstorm 第一版"落 MinIO"提议，见 `dramaforge-assets-client-local`）；② **前端对齐 app1**（见 `dramaforge-frontend-align-app1`）。recon 摸清：dramaforge `/api/generate/video` 路由已存在可用（POST+requireUser+callAI 返 ARK TOS 1h 过期临时 URL envelope，**零持久化/零服务器存储**；chain-generate[P5]已在消费它），gateway 13 provider 通（ARK Seedance 主力，key server-side GC-1），MinIO backend 就绪但新约束下不存资产。

plan `docs/superpowers/plans/2026-07-19-cs-ui-vertical-slice-p4.md`(基线 626299e) → subagent-driven 2 task + 1 fix 全 review-clean + whole-branch opus **Approved（Yes-with-followups，FIX-1 收口）**：

**Task1**(client `fa0f3b8`) Electron main 资产设施——`asset-store.ts`(下载 URL→`userData/clips/<clipId>.mp4`，AbortSignal 180s，原子 `.tmp→rename`，路径穿越 5 道防御)+`sf-asset://` protocol(`protocol.handle` Electron 43，`registerSchemesAsPrivileged` whenReady 前)+`sfShell` preload bridge(`downloadAsset`/`isElectron`，IPC 边界 strip localPath)；

**Task2**(web `3095357`) `/generate` 页——useSession 门+prompt 表单(视觉照 app1 `ProductionStage.tsx` 闪电 SVG path 字符级一致)→POST 路由拿临时 URL→`sfShell.downloadAsset` 落盘→`<video src=sf-asset://>` 播本地，非 Electron fallback 播临时 URL；抽 `runGenerate` 纯函数(node-env 测试对齐仓库风格)；

**FIX-1**(`10f1a26` whole-branch must-fix)`await downloadAsset()` 包 try/catch→降级 `DOWNLOAD_IPC_ERROR`(honors"永不 reject"防 loading 卡死)+回归测试。

**whole-branch opus 独立验**（实读+grep 非信报告）：服务器零视频字节、渲染层零 file://、类型字节级一致(preload≡generate-flow)、app1 视觉真实、**F1 CSP 全目录零命中→sf-asset: 放行**、GC-1 前端零 key。Leave 9 Minor(F2-F7/M2-M4 全 leave-acceptable)。gate 全绿：client 127/web 128 test，typecheck clean，web build 绿 `/generate` 进路由。commits **626299e..10f1a26**(4 个：0086750 plan/fa0f3b8 T1/3095357 T2/10f1a26 FIX-1)。

**CP2 第一块结构达成** ✅。**⚠️真用户端到端=用户手动**：填 `ARK_API_KEY` 到服务器 `.env`(GC-1 自有)→重启 web→桌面客户端 `/generate`→prompt→生成→看到视频+确认文件落 `C:\Users\<u>\AppData\Roaming\DramaForge CS\clips\`。

**下一步=P5 chain-generate 合片**(dispatch CONCAT→Electron render-worker ffmpeg→SSE→本地成品)。生产仍 app1 服务，dramaforge 分支 `feat/cs-ui-slice`(main 48fefc4 未动)。

---

## 续16 (2026-07-19) ✅✅ C/S 垂直薄片 P3 项目列表 done + CP1[=P0-P3]结构达成

续13。P2 本地登录用户实测通过（cmd 语法 `set "SF_DEV_URL=http://localhost:3001" && "...DramaForge CS.exe"` + 杀光所有 DramaForge CS.exe 进程避免单实例锁转发；期间发现 middleware lockout[task#39：生产模式非 Electron UA 的页面请求 302→/download]、heartbeat 404 是噪音[客户端后台 heartbeat 打硬编码 your-domain.example.com/app1 无 /api/client/heartbeat，不阻断 UI 登录]）。用户「继续」→ P3。

recon(agent sonnet) → plan `docs/superpowers/plans/2026-07-19-cs-ui-vertical-slice-p3.md`(基线 4c5ca13) → subagent-driven 3 task + 2 security fix 全 review-clean + whole-branch opus **Approved（Yes-with-followups，CP1 结构达成）**：

**Task1**(server/shared 契约：`shared/project.ts`[ProjectStatus 6值/Category/Record 19字段/zod `createProjectSchema`] + `server/domain/project/{service,validation,index}.ts`[`projectRepo={listByUser,create}` 照 render-job-repo，SQL camelCase 列加双引号，genId 纯 uuid，no try/catch] + 双 barrel，`df9af14`) + `server/vitest.config.ts`(service 值导入 @shared/project 触发，历史 server 测试只导 type 不需)；

**Task2**(web `/api/projects` route GET listByUser + POST create 照 dispatch[requireUser/AuthError + apiSuccess/apiFail/handleApiError + createProjectSchema.parse inner try/catch]，`70a1cf7` + I-1 fix malformed JSON 500→400 INVALID_JSON[照 dispatch:100-111] `80a1702`)；

**Task3**(web `workspace/page.tsx` useSession 三态 + 直接 fetch 卡片网格[状态徽章/标题/描述/更新时间] + 新建 title 弹窗[不跳 /workspace/[id]，toast+重新 fetch] + 空态内联 + 裸 header，砍 useAuthFetch/AppHeader/CreditsBadge/Tab/删除/ConfirmDialog；callback-url.ts 3 处 fallback `/`→`/workspace`[显式 `/` 仍 `/` 同源保留]，`4a8a29c`)。

**3 个连续 callbackUrl 安全 fix（P3 review 触发的安全收敛）**：backslash `/\evil.com`(`2571792`：WHATWG `\`→`/` → `//evil.com`) + control-char `/\t|/\n|/\r/evil.com`(`80e1fab`：WHATWG 去除 control → `//evil.com`，opus 用 Node URL parser 实测确认) → `sanitizeCallbackUrl` 现为 **5 道 guard**(非字符串 / 不以 `/` 开头 / 以 `//` 开头 / 含反斜杠 / 含 ASCII control chars[regex `/[\x00-\x1f\\]/`])，whole-branch opus 安全专节确认无残留 bypass。

**关键技术决策**：project-repo 放 `domain/project/` 三件套(project 是核心业务实体非调度队列实体，与 asset/storyboard 一致；render-job 在 task/ 是调度实体)；projects 表已存在(`0001-init.sql`)不需 migration，列名 camelCase 加双引号(Prisma 遗留)；envelope 失败 helper 叫 **apiFail 不是 apiError**(后者 M2M bare 路径被 render-job-guard/api/client/*/sse 引用，禁用)；workspace 直接 fetch(cookie 自动带，无 useAuthFetch)。

**whole-branch opus**：跨 task 契约 4 层全对齐(shared 19 字段 → SQL → service → route → workspace，无臆造/丢弃)，carryover Minor 未恶化，P2 M-1(router.refresh 冗余)被 P3 workspace 实际解决可关闭。测试 shared/server/web typecheck clean；web 117 tests；server 399。commits **4c5ca13..80e1fab**(6 个：df9af14/70a1cf7/80a1702/4a8a29c/2571792/80e1fab)。

**CP1 结构达成** ✅：`/workspace` 未登录 → 登录 CTA → signin → 凭据 → session cookie → callbackUrl `/workspace` → `useSession` authenticated → `fetch /api/projects` → 卡片网格 → 新建 → POST → 新卡。本地 web 镜像 rebuild 带 P3(后台)。

**⚠️真用户 workspace 交互 + 视觉 = 用户手动**(SF_DEV_URL 启桌面客户端 → 登录 → 跳 `/workspace`[非冒烟页，callbackUrl 改了] → 空态 → 新建 title → 新卡顶部 → callbackUrl 回归[登出再登自动落 /workspace] → open-redirect 回归[?callbackUrl=https://evil.com 登录后落 /workspace])。

**下一步 = P4 AI 视频生成**(CP2=P4-P5)。生产仍 app1 服务，dramaforge 分支 `feat/cs-ui-slice`(main 48fefc4 未动)。

---

## 续13 (2026-07-19 深夜) ✅ C/S 垂直薄片 P2 登录 done

续12。P1 后用户「继续」→ P2。recon agent `a5ab949b`(51 tool calls) 关键发现：**dramaforge NextAuth 后端已完整接线**——`packages/server/src/infra/auth.ts` 完整 `CredentialsProvider`（`authorize()` 内联 `normalizePhone` + 单 SQL `email=$1 OR phone=$1 OR phone=$2` + `bcryptjs.compare` + 写 `activeSessionStamp` + JWT/session 回调暴露 userId/role）；users 表（`migrations/0001-init.sql`）有 `passwordHash`/`phone`/`activeSessionStamp`；`bcryptjs ^2.4.3` 已是 server dep；`scripts/app1-data.sql` 有 4 迁移用户带 bcrypt `$2b$10$` hash（3 phone-only + admin `admin@local.dramaforge`）；续6 本地 docker 已实战验证登录链（seed 用户→session）。→ **P2 纯前端，server 零改**。

plan `docs/superpowers/plans/2026-07-19-cs-ui-vertical-slice-p2.md`，分支仍 `feat/cs-ui-slice`（基线 70a2f7b，main 仍 48fefc4）。subagent-driven 2 task + 1 Important fix 全 review-clean + whole-branch opus **Approved（Yes-with-followups）**：

**Task1** 移植 app1 `auth/signin/page.tsx`(224 行)+`login-identifier.ts`(逐字 7 行)+测试，**3 有意偏离**（`@/`→相对 `../../../components/ui/...`、lucide `Eye`/`EyeOff`→inline SVG 因 `^1.21.0` 公开 npm 不存在、callbackUrl 默认 `/workspace`→`/`）；fix pass 补测试覆盖(phone/invalid/empty)+JSDoc（`3bc0459`/`0dd6fd5`）。

**Task2** 冒烟页 `app/page.tsx` 加 `useSession()` 三态 banner（loading/authenticated 显 email||name||id+(role)+登出/unauthenticated+跳登录），`SessionUser` cast 同 `web/lib/auth.ts` 约定（无 `next-auth.d.ts` 模块增强）（`6cfb979`）。

**whole-branch 1 Important I-1 callbackUrl open-redirect**（page.tsx `router.replace(callbackUrl)` 无同源校验，`signIn` 用 `redirect:false` 故 NextAuth allow-list 不生效→`?callbackUrl=https://evil.com` 登录后跳钓鱼站，faithful app1 bug）→ fix 抽 `sanitizeCallbackUrl`（`callback-url.ts`：同源绝对路径 string∧startsWith`/`∧¬startsWith`//` 才放行，否则 `/`）+6 测试，page.tsx 改用；re-review 对抗 probe 全过（含 `%2F%2F` decode-then-sanitize 边界安全：URLSearchParams 先解码成 `//evil` 再喂 sanitize 被拒）（`b8c2d9a`）。登录链 reviewer 亲 trace 全 seam 一致（client signIn args→Credentials schema→authorize SQL/bcrypt→JWT/session callbacks→SessionProvider→冒烟页 useSession）。

测试 99/99，typecheck clean。commits **70a2f7b..4c5ca13**（5 个：3bc0459/0dd6fd5/6cfb979/b8c2d9a/4c5ca13 docs）。

**残留风险全在 cutover env**：`NEXTAUTH_URL`/`NEXTAUTH_SECRET` 必须是 prod 真值——**非** Dockerfile build-placeholder（`http://build.local` / `build-placeholder-not-used-at-runtime`，env.ts Zod 只查非空不查熵，否则 JWT 可伪造）；`__Secure-` cookie 前缀依赖 https。

**⚠️ 真用户登录+视觉=用户手动 checklist（6 步，WORKLOG 续13）**：Step0 env 先查（`docker compose exec web printenv | grep NEXTAUTH_`）确认 URL=https+SECRET 随机；Step1 admin email 登录；Step2 phone-only 登录（不同 code path，email=NULL name 兜底）；Step3 负测（错密码/foo/5位密码）；Step4 Electron session 持久（关重开仍登录，cookie #1 cutover 风险）；Step5 open-redirect probe（`?callbackUrl=https://example.com` 应跳 `/`）；Step6 signOut 循环。本会话无 browser-harness + 无明文密码无法自验。

**下一步=P3 项目列表**（`project-repo.ts`(server 照 render-job-repo 模板查 projects 表)+`/api/projects`(新信封 GET list by userId/POST create)+精简 `workspace/page.tsx` 卡片网格；callbackUrl 回 `/workspace`）→ P4 AI gen → P5 合片。**CP1=P0-P3**（还差 P3）。生产仍 app1 服务（完整 UI HTTPS 200），dramaforge 全容器 stop 数据卷+镜像保留。

---

## 续12 (2026-07-19 深夜) ✅ C/S 垂直薄片 P1 UI 脚手架 done

续11。P0 后用户「继续」→ 本会话做完 P1。recon agent `a9b5d772`（34 tool calls）摸清 app1（在 **`D:/app1/` 非 F:**）UI 资产：globals.css 481 行 Tailwind v4 CSS-first 暗色设计系统（`@import "tailwindcss"`+`@theme`动画token+`:root`暗色变量`--accent`amber/`--action`blue+`.light`覆盖，**无 tailwind.config**）、cn.ts 标准 twMerge(clsx)、Button(大写B)依赖 @radix-ui/react-slot(asChild)+./Spinner+./cn 非 CVA、Input.tsx 一文件含 Input/Textarea/Label/FormField、Toast.tsx 纯 React Context **零 Radix**、AuthProvider 包 next-auth SessionProvider。

plan `docs/superpowers/plans/2026-07-19-cs-ui-vertical-slice-p1.md`，分支仍 **`feat/cs-ui-slice`**（基线 67fd08b，main 仍 48fefc4 未动）。subagent-driven 4 task 全 review-clean + whole-branch opus **Approved（Yes-with-followups，无 Critical/Important code finding）**：

①web 加 clsx/tailwind-merge/@radix-ui/react-slot(dep)+tailwindcss/@tailwindcss/postcss(dev)+postcss.config.mjs（593f7d0）
②逐字 cp globals.css+cn.ts（cd78fff，cmp+sha256 byte-identical）
③逐字 cp Spinner/Button/Input（0916489）
④逐字 cp Toast+AuthProvider + layout 挂 `AuthProvider>ToastProvider`+import globals.css + app1 metadata + 冒烟页(page.tsx "use client" Button→toast.success+受控Input+Textarea+FormField)（1ab74d6）。

**`next build` 绿=Tailwind v4+Next16 pipeline 通**；测试 shared13/server383/web89/client105 全绿，5 包 typecheck clean。设计系统链路 opus 亲 trace 全通（Button variant→.btn-primary→@layer→var(--action)←:root；Toast animate-slide-in-right←@theme+@keyframes）。commits **67fd08b..70a2f7b**（5 个，含 1 docs）。

**P1 唯一偏离 app1**：Input.tsx 加 `Omit<InputHTMLAttributes,"prefix">` 修 app1 潜伏 TS2430（prefix:ReactNode vs 原生 prefix:string，app1 20+错不 gate；runtime 不变）。

**defer**：lucide-react（app1 写 ^1.21.0 但公开 npm 不存在，P1 组件不用图标，需时先核实 node_modules 真版本）；@radix-ui/react-dialog(P0 期 Modal/ZoomViewer 用)/label(app1 零引用)/qrcode.react(RechargeModal 用)；AppShell/RechargeProvider(layout 不挂)。

**M1 bare `next build` env-at-build-time**：dev-only——`/api/auth/[...nextauth]`(P0 commit 51631d5) build 时触发 env.ts 懒校验需 8 infra 变量，**Dockerfile 已有 8 build-time ENV placeholder+3 次 cutover build 全绿，非 prod 风险**，`force-dynamic` 是可选清理 ticket。

**⚠️视觉冒烟 defer（用户手动）**：本会话无 browser-harness MCP，像素级验暗色渲染未做；起 `pnpm --filter @dramaforge/web dev`→localhost:3000（dev UA gate P0 Task2 已放开浏览器）看暗色背景+点 Button 弹 Toast。

**下一步 = P2 登录**（移植 app1 auth/signin/page.tsx+login-identifier.ts，凭证 password-only `signIn("credentials",{login,password,redirect:false})`，迁移用户实测登进；NextAuth v4 Credentials 已在 server，P2 是首次 session runtime 验证，注意 Electron loadURL SameSite cookie 风险）→ P3 项目列表 → P4 AI gen → P5 合片（CP1=P0-P3，CP2=P4-P5）。生产仍 app1 服务（完整 UI HTTPS 200），dramaforge 全容器 stop 数据卷+镜像保留。

---

## 续11 (2026-07-19 晚) ✅ C/S 垂直薄片 P0 基建 done

续10。续9 三岔路里用户选 **② 垂直薄片**（先验 C/S 闭环再定全量）。plan `docs/superpowers/plans/2026-07-19-cs-ui-vertical-slice.md`，分支 **`feat/cs-ui-slice`**（基线 main `48fefc4`，**不在 main 提交**）。走 superpowers subagent-driven-development（每 task implementer+reviewer subagent + final whole-branch review）。

**P0 基建 6 task 全 review-clean + whole-branch review（opus）Approved "Safe to build P1 on top of"**（无 Critical）：
①信封统一（apiSuccess/apiFail/handleApiError）
②中间件 dev 放开浏览器
③MinIO 公网 URL 修（signing-client split + region/trailing-slash/path-prefix guard）
④outputKey 契约 + dispatch 自动签 outputUploadUrl + executor 回 meta.outputKey
⑤presign-GET 路由（normalize-before-authorize 防 path traversal，reviewer 亲自 trace 验证）
⑥a nginx provision 脚本+config+runbook 留档。

17 commits `48fefc4`..`58c434f`。测试 shared 13/server 383/web 89/client 105 全绿，5 包 typecheck clean。whole-branch fix pass 修了 chain-generate orchestrator 被 Task 1 信封静默破坏（mock theater）。ledger `.superpowers/sdd/progress.md`（gitignored scratch，compact 恢复锚点）。

**Task 6b DEFER**：用户加 DNS `minio.your-domain.example.com` A→YOUR_SERVER + 我 SSH `bash scripts/provision-nginx-minio.sh` + `certbot --nginx -d minio.your-domain.example.com --redirect` + re-cutover 时切 `.env` `MINIO_PUBLIC_BASE_URL=https://minio.your-domain.example.com`（详见 `docs/ops/minio-public-ingress.md`）。

**下一步 = P1 UI 脚手架**（新 plan：web 加 tailwind4/radix/lucide，移植 app1 globals.css/cn.ts/Button/Input，root layout 挂 SessionProvider+ToastProvider）→ P2 登录 → P3 项目列表 → P4 AI gen → P5 合片（CP1=P0-P3，CP2=P4-P5）。生产仍由 app1 服务（完整 UI HTTPS 200），dramaforge 全容器 stop 数据卷保留。

---

## 续9 (2026-07-19) ⚠️ 已 rollback 回 app1——dramaforge 无 UI 缺口暴露

续8。用户装上 DramaForge CS 客户端打开后只见桩页 "C/S web layer — UI port pending" → 才发现 dramaforge **没有产品 UI**（15 模块全是后端/管道/运维，UI 移植从一开始划在范围外，续8 已记）。之前看到的 UI 是 app1 的；cutover 把有 UI 的 app1 换成没 UI 的 dramaforge = "切了等于没切"。

**用户选 A 回滚**：跑 `bash scripts/rollback-cutover.sh`（preflight 确认 dramaforge 5 容器 Up 占 :3000、app1 四容器 Exited(0) 保留、nginx 固定→127.0.0.1:3000 对称切换），全绿——sf-web healthy、**生产回到 app1（完整 UI 恢复，title="DramaForge AI 视频创作平台"，HTTPS 200，桩页消失）**。dramaforge 全容器 stop 但**数据卷（dramaforge_pg_data）+镜像全保留**在服务器，UI 移植完可直接 re-cutover（dramaforge 一行没丢）。

**下一步=把 app1 前端移植进 dramaforge packages/web（C/S 适配），做好再 re-cutover；之前不能上线**。

### == 以下是 cutover 第3次历史（已被 rollback 取消）==

**原 cutover GREEN（WORKLOG 续7，commit 1b8632c）**——`bash scripts/cutover.sh` 9 步全过，4/4 bug 修复生产实战扛住。真实 app1 数据落 dramaforge（users 4/projects 17/shots 101/tasks 76/assets 45/billing 42/api_configs 12/episodes 69）。post-verify：5/5 容器重启 0、web healthy、ai-worker `已启动4Worker` 不 crash（bug④ 前两次就死这）；**内存 OOM 消除：app1 1.8GB→宿主 used 720MB/available 1150MB**（C/S 核心：ffmpeg 挪走）；NextAuth 功能正常（NEXTAUTH_SECRET len=44 + csrf 合法 token），web 日志 24 次 JWT_SESSION_ERROR=**旧 app1 cookie 被拒 benign**（重登自愈）；外部 HTTPS /api/health 200。app1 容器 stop 保留供 rollback-cutover.sh。

**⚠️缺口**：migrate 只迁 DB 不迁文件，45 条 assets 仍指 app1 存储(web 已 stop)→旧项目图片加载前需补文件迁到 dramaforge-minio（手动验证项②）。本地测试 stack 仍跑 WEB_PORT=3001。15 模块名义交付——**但⑤web 实测只有 C/S 骨架：仅 13 路由(auth/health/sse/generate×2/render×5/client×3)、0 组件、无 Tailwind/Radix/lucide；计划里写的"78 API+UI"从未实现**（续10 核实）。527 测试只覆盖这 13 路由的 C/S 核心+ .exe v4 启动验证通过。

**cutover 试 2 次都 rollback**：踩 4 个潜伏 bug（全没被"本地 e2e"抓到——本地 e2e 测客户端 render-worker/force_upgrade，没测服务器 docker 镜像跑 prod bundle）。

**已修 4/4（全提交，2026-07-18）**：
① cutover.sh/rollback-cutover.sh `$SSH`→`${SSH[@]}`（裸数组只展开首元素）
② 两 Dockerfile 加 `--config.node-linker=hoisted`（pnpm 默认 isolated 布局→镜像缺 pg/ioredis，server+web 同病）
③ migrate-app1-data.sh run_psql_prod 远端 word-split 引号修（`$*` 嵌 ssh 串，`-c` 只拿首词）
④ ai-worker next-auth：**B 互操作 unwrap**（`import _CP; const CP = (_CP as any).default ?? _CP`——实测 `m.default.default` 才是 fn，next-auth v4 provider 经 esModule 互操作 double-wrapped）+ **A barrel-cut**（authOptions 移出 @server/infra barrel，改根 barrel 直连 `./infra/auth` 喂 web；worker 的 @server/infra 路径不再拖 auth.ts/next-auth）。

bug4 bundle 级验证：worker next-auth 引用 1→0、bundle import 不再 crash。commits：bug1-3 = 314535b/e16ba12/4177589/fcf4f2e，bug4 = 06e5a68（B 互操作）/ ff9ca4a（A barrel-cut）/ **16f1145（B 类型回归修：`as any` 让 authorize(credentials) 丢类型推断，next build noImplicitAny 报错；改 `as typeof _CredentialsProvider` 保留类型——此回归只在 docker web build 全量类型检查暴露，本地 esbuild transpile-only 不查）**。

**全栈本地 docker 验证 GREEN（#37 ②，WORKLOG 续6）**：down -v 干净起 stack → migrate 建 16 表 + web next build 过 + ai-worker 启动不 crash（4 worker 在线，重启 0）+ **web auth 实战登录全链路通**（seed 用户→NextAuth credentials→session 返回）+ **ai-worker 真消费 job**（直连 redis 入队 VIDEO_GENERATE→completed:1）。4-bug 教训闭环→**可 re-cutover**。cutover 第 2 次其实 [5][6][7][8-web] 全过，当时只差 ai-worker（现已修+实测）。已 rollback 回 app1（全 healthy HTTPS 200），dramaforge 数据卷（dramaforge_pg_data 含迁移数据）+ 镜像保留。本地测试 stack 仍在跑（WEB_PORT=3001，宿主:3000 被别的 node 占）。F:\app1 比 D:\app1 新 10 提交（纯支付宝充值功能，payment_orders 表，本地开发从没上生产，服务器无支付）→ task #36 cutover 后移植。

### == rollback 后下一步（历史）==

**新会话下一步**：
① 读 WORKLOG「续9」段 + 本记忆（**已 rollback 回 app1，dramaforge 无 UI 缺口暴露**）。**生产现状**：your-domain.example.com 由 **app1** 服务（sf-web/worker/postgres/redis Up healthy，完整 UI，HTTPS 200）；dramaforge 全容器 stop 但数据卷（dramaforge_pg_data）+镜像保留，UI 移植完再 re-cutover。
→ ② **剩余手动验证（需真账号/客户端，用户做）**：① Electron 客户端用迁移用户登录 ② 旧项目 uploads 加载（**+ 补文件迁移 app1 存储→dramaforge-minio**，DB-only 迁移的缺口）③ 一个 FILM_EXPORT。
→ ③ **task #29 客户端更新通道**（publish-client.sh + nginx /downloads/ 托管 .exe + manifest）；老 Electron 客户端持旧 app1 token 撞 dramaforge 产生 JWT 错误，更新通道 + MIN_CLIENT_VERSION 强制淘汰可解。
→ ④ **task #36 支付宝移植**（F:\app1 比 D:\app1 新 10 提交，payment_orders 表，本地开发从没上生产，服务器现无支付）。
**task #28 cutover + #37 离线修 全部完成**。

---

## 探索发现 (2026-07-18) 3 个 Explore agent 摸完全栈，决定走 P0-2 更新通道

- **UI 缺口已确认（最关键）**：dramaforge **没有产品 UI**。`packages/web/app/` 只有 3 个 tsx——`page.tsx`(健康桩 "UI port pending")、`download/page.tsx`(浏览器挡到"用桌面客户端")、`layout.tsx`。客户端纯薄壳 `loadURL('https://your-domain.example.com')` 无渲染层。15 模块里**没有 UI 模块**，UI 移植从一开始就划在范围外("follow-up iteration")。→ 现在链路是死的：浏览器→挡到下载页→桌面客户端→加载云端→只有桩页。**UI 移植是"生产能用"的真正拦路虎，是独立大工程**。

- **存储管线 latent bug（留给存储/UI 期修）**：① MinIO upload 返回的 url=`${MINIO_ENDPOINT}/${bucket}/${key}`，prod 里 MINIO_ENDPOINT=`minio`(docker 内网名)→**存进 DB 的 URL 客户端/浏览器解析不了**，UI 落地后素材显示会全断；② **web 无 multipart 上传路由**（生产写 MinIO 的只有 ai-worker + /api/client/logs）；③ **MinIO 无 TTL/lifecycle/cleanup**，对象只增不删；④ StorageBackend 的 presign/delete **生产从不调用**（dormant）；⑤ render dispatch 的 `outputUploadUrl` 需调用方自己造，服务器无 route 生成 presigned；⑥ materials 表是死代码。

- **更新通道现状（P0-2 要补的）**：`publish-client.sh`✅已存在(scp exe+写 CLIENT_VERSIONS_MANIFEST+curl验/downloads/)；`/api/client/heartbeat`+`/api/client/update`✅；客户端 heartbeat✅(30s) 但**lockout 位设了没消费**(无强制升级界面)；updater⚠️**只下载不安装/不重启**；nginx `/downloads/`⚠️文档写了但**服务器没加**；prod system_configs=0 行**manifest 未种子**；客户端版本还是 `0.0.0`。

- **用户决策**：先做不依赖 UI 的 **P0-2 更新通道**；存储分层(P0-1)和 UI 移植一起设计（后期）；P0-3 登录导出因无 UI 改 API 级冒烟。

- **P0-2 更新通道已全通（task #29/#38/#39 done，WORKLOG 续8，client commit 681466b）**：用户选"提示后安装"。Slice A 服务器侧——nginx 加 `/downloads/`(alias client-releases/)+reload、种子 `system_configs.CLIENT_VERSIONS_MANIFEST`、publish-client.sh 跑通。Slice B 客户端——版本 0.0.0→1.0.0；updater onDownloaded 接 promptAndInstall（弹提示→copy .exe→spawn NSIS /S→quit，runAfterFinish 重启）；heartbeat onForceUpgrade 接 handleForceUpgrade（block 弹窗→openExternal→quit，try/catch/finally 必退出，**消费了之前设了没用的 lockout 位**）；heartbeat os 'win'→detectOs()。typecheck 绿 102/102 测过。1.0.0 已发布（latestVersion=1.0.0/minVersion=0.0.0 软更新，/downloads/ 200，/api/client/update 验证返回 1.0.0）。**手动验证待用户**：提示流是 GUI 交互+首轮鸡生蛋（新代码在 1.0.0，旧 0.0.0 客户端用旧 updater 只下载不提示），需手动装一次 1.0.0 后实测下一轮。
