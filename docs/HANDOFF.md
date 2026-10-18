# HANDOFF — 新会话/compact 后先读这里

> 最后更新:2026-07-20(批3 commit + 验证码生产通 + 批4 recon)
> 项目:dramaforge C/S 重构 `D:\dramaforge-cs`(pnpm monorepo,分支 `feat/cs-ui-slice`)
> 参考:app1 `F:\app1`(只读,GC-3)

## 当前状态一句话

**批0~修C 已部署生产 + 验证码生产通(2026-07-20,signup 能发真短信)。迁移进行中:批2 ✅ `4b3304d` / 批3 ✅ `accee2d`(InputStage+LanguageMenu+import-docx+text-to-style,review 全绿),批4 recon 中(analyzing)。攒批节奏(批4-6 后统一部署)。核心:dramaforge=app1 C/S 迁移,一切照 app1,只变接入层/部署/媒体存储。**

## 生产部署实况(2026-07-20 续32 cutover)

- **服务器**:root@YOUR_SERVER,SSH key `~/.ssh/deploy_key`(本机),需 `chmod 600` + `-i` 指定
- **部署目录**:`/opt/dramaforge`(docker-compose.yml + .env + override)
- **生产 DB**:`dramaforge`(postgres 容器),**不是** `video_stylization`(那是 /root/dramaforge-prod.env 旧值,app 实际连 dramaforge)
- **migration 跟踪表**:`_migrations`(name + applied_at),已到 0001-0004
- **compose 容器**:dramaforge-web / dramaforge-ai-worker / dramaforge-migrate(--profile migrate,复用 ai-worker 镜像跑 dist/migrate.js)/ dramaforge-postgres / dramaforge-redis / dramaforge-minio
- **nginx**:已配 `proxy_set_header X-Real-IP $remote_addr` + `X-Forwarded-For $proxy_add_x_forwarded_for`(XFF 是追加非覆写,但 x-real-ip 优先兜住,C4 基本满足)
- **回滚**:`bash rollback.sh`(本地)→ tag `:rollback` 重打 latest + compose up。**migration 不回退**(只增不减)
- **部署脚本**:`deploy.sh`(一键:build→tag rollback→load→migrate→up→健康)/ `rollback.sh` / `scripts/rollback-cutover.sh`

## cutover checklist(每次部署前必过)

1. commit 回滚锚(`feat/cs-ui-slice`)
2. nginx 配 `X-Real-IP $remote_addr`(已配)
3. 部署 migration 前验证:无同号 phone 重复(`SELECT phone,COUNT(*)...HAVING>1`)+ 无非 +86 phone(`SELECT...NOT LIKE '+86%'`)
4. migrate.js 事务(compose `--profile migrate run --rm migrate`)
5. server .env `SMS_MOCK_ENABLED` 不为 true(production 拒绝 mock)

## 已部署版本能力(批0~修C)

- **主链**(续29 通):剧本→分析→资产→分镜→串生成 ✓
- **UI 复刻**(批0~1.5):AppShell+sidebar5 / 列表富化 / 设置+Recharge / 手机短信注册
- **安全加固**(修A/B/C):类型+hooks / CSRF+download-limit+tags+role / signup 5C+9I(枚举/限流/mock正向/IP/Lua原子/bcrypt12/phone迁移0004)
- 三包绿:server 484 / web 199 / client 150

## 待办(完全对齐 app1,批2~9.5)

recon 已就绪,按 `docs/REPLICATE-APP1-PLAN.md` 顺序:
- **批2** ✅ commit `4b3304d`:EpisodeWorkspace orchestrator(836行)+ SSE QUEUED(dispatch 5函数)+ lib/api(useApi)+ stage-config(长 app1 label)。review 全绿(build + 229 test)。**未部署**(攒批)
- **批3** ✅ commit `accee2d`:InputStage+LanguageMenu+import-docx+text-to-style routes(迁移 app1,砍 video 双 Tab 占位)。review 全绿(build + 229 test)。**未部署**(攒批)
- **批4** 🔄 recon 中:analyzing 阶段(app1 AnalyzingStage 556行)。brief:`docs/recon/批4-analyzing-recon.md`
- **批3-6**:input/analyzing/assets/storyboard 各阶段 UI
- **批7**:production/合片。recon:`docs/recon/P5-合片-state-recon.md`。⚠️**违规债**:CHAIN_COMPILE 仍 uploadArtifact MinIO(`packages/client/src/orchestrators/chain-generate.ts:235`),违反 dramaforge-assets-client-local,批7 第1优先修
- **批8-9.5**:成片库 / 收尾 / admin

## client 同步(Electron)

- 批0.5 改 client(asset-store 图片 ext + preload downloadAsset opts)
- 旧 client + 新 web **兼容**(媒体 ext 走 URL suffix fallback),不阻塞
- client 发版(electron-builder + 分发)后续;打 clientrelease 到 `/opt/dramaforge/client-releases/`
- 注意:Electron 打包 ffmpeg 须 `asarUnpack` 排除二进制

## 硬约束(不可违反)

- **GC-1**:AI key 只在 server,无 BYOK
- **GC-3**:app1 (`F:\app1`) 只读参考
- **GC-5**:server 1.8GB,**禁止在 server 跑 next build/docker build**(全本地 build + save|load)
- **GC-6**:每步追加 `archive/WORKLOG.md`(时间线,续NN)
- **GC-7**:只在 `feat/cs-ui-slice`,不碰 main,不随意 commit(等用户)
- **GC-8**:SMS/AI key 只占位变量名进 `.env.example`,不入 git
- **dramaforge-assets-client-local**:媒体字节只存 Electron client 本地(sf-asset://),server 不存
- **dramaforge-keys-cloud-server-only**:AI key 云端,用户无 BYOK
- **dramaforge-frontend-align-app1**:UI 照 app1(F:\app1 活的,非 D:\app1),不自创
- **prefer-better-lib-not-selfbuilt**:用成熟库(Radix+lucide),别自研
- **CLAUDE.md 视觉**:UI 检查必须截图+视觉模型,不逐行读代码推断

## 文档索引(本拆分)

- `archive/WORKLOG.md` — 时间线(续NN,抗 compact 主记录)
- `docs/HANDOFF.md` — 本文件,新会话入口
- `docs/REPLICATE-APP1-PLAN.md` — 完整复刻计划+10批路线
- `docs/recon/批2-EpisodeWorkspace-SSE-recon.md` — 批2 实现 brief
- `docs/recon/P5-合片-state-recon.md` — 批7 合片 recon(14项gap+移植要点)
- `deploy.sh` / `rollback.sh` — 部署/回滚脚本

## build 命令速查(本地)

- web build:`cd /d/dramaforge-cs && set -a && source .env && set +a && cd packages/web && pnpm build`
- docker build web:`docker build -f packages/web/Dockerfile -t dramaforge-cs-web:latest .`
- docker build ai-worker:`docker build -f packages/server/Dockerfile -t dramaforge-cs-ai-worker:latest .`
- 一键部署:`bash deploy.sh [tag]`(会重新 build)
- **绝不 pipe `pnpm build | head/tail`**(tail exit 0 掩盖 pnpm 真实 exit)
- **绝不 `docker compose up ... | head`**(SIGPIPE 中断)
