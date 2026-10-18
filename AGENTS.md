# AGENTS.md — DramaForge C/S (dramaforge)

> 这是**地图，不是说明书**。先读这里定位方向，深一层去 `docs/INDEX.md`。改造哲学见 `docs/superpowers/specs/2026-07-27-harness-engineering-design.md`。

## 这是什么
dramaforge = `D:\app1`（B/S web 应用）迁移到 **C/S 架构**的产物。一切行为照 app1，只变三件事：接入层（B/S→C/S）、部署（Docker + Electron）、媒体存储（→客户端本地）。

- **服务器 = 薄**：只持 AI key + DB 元数据。零媒体字节、零带宽 = 不 OOM 不崩。
- **客户端（Electron）= 重**：ffmpeg + 所有媒体资产都在本地硬盘。
- **生产**：云端 `YOUR_SERVER`，Docker（dramaforge-web / dramaforge-ai-worker / postgres / redis / minio），HTTPS `your-domain.example.com`。

## 架构分层（依赖只能向前）
pnpm monorepo，包间依赖方向严格：
```
shared ──► server ──► web
   │                   │
   └────► client       │
                         ▼
                       e2e（只读依赖，测全链）
```
- `packages/shared` — 契约/类型/client-api（最底层，不依赖其它包）
- `packages/server` — domain（billing/concurrency/prompt/task）+ ai-worker（BullMQ 队列）+ web 路由（Next.js）
- `packages/web` — Next.js 前端（**视觉/交互照搬 app1，不自创**）
- `packages/client` — Electron 主进程（ffmpeg/IPC/updater）+ 渲染进程
- `packages/e2e` — 全链测试

跨层关注点（认证/遥测/feature flag）走单一显式接口，不许乱穿层。

## 硬约束（🔒 机械强制，见 `.claude/hooks/guard-invariants.py` + `docs/known-issues/architecture-and-migration.md`）
| ID | 约束 | 一句话（**当前真实状态**） |
|----|------|--------|
| H1 | 媒体资产只存客户端本地 | **目标**；chain 主链路已对齐，hook 拦新代码入库；⚠ 单镜头 IMAGE/VIDEO 仍 `persistVideo()` 落服务器 = app1 遗留债待清退（见 `docs/known-issues/architecture-and-migration.md` §H1） |
| H2 | AI key 只在云端服务器 | ✅ 成立（client 全量 grep 零 key）；客户端无 BYOK，本地无法真生成 |
| H3 | 前端照搬 app1 | ✅ 流程级成立（stage 一一对应 app1）；视觉对齐无 hook，靠纪律 |

其它边界（命名/文件大小/日志结构）靠 linter，此处不列。

## 东西在哪
- **怎么部署/回滚/发版** → `docs/ops-access.md`、`docs/deploy-history.md`（续N 完整历史）、`docs/version-update-runbook.md`
- **已知坑/根因/存活规则** → `docs/known-issues/`（chain 假死 / 连续性提示词 / 架构迁移 / 计费安全，每条带 ✅⚠📦 liveness）
- **复刻 app1 的计划** → `docs/REPLICATE-APP1-PLAN.md`
- **侦察/审计/报告** → `docs/recon/`、`docs/reports/`、`docs/prompt-alignment-audit.md`
- **设计文档与执行计划** → `docs/superpowers/specs/`、`docs/superpowers/plans/`
- **全 docs 索引** → `docs/INDEX.md`（含校验状态）

## 怎么干活（agent 优先纪律）
1. **核验再断言**——记忆/docs 可能过期，改代码前先读当前代码确认 liveness。
2. **没部署就说没部署**——区分"tsc/测过"vs"运行时冒烟过"，不把未验状态当事实。
3. **照 app1 别自作主张加严**——app1 没有的硬拦截不要自加（历史教训：自加 409 拦截致每次生视频卡死）。
4. **改了就测**——4 包 tsc + 相关测；部署走 `deploy.sh`，发版走 `publish-client.sh`。
5. **真生成需云端 key**——本地无法验真生成，只验结构/契约；运行时冒烟须用户桌面端。
6. **闭环：错就改造系统，别只在对话里提醒**——修完 bug 自问：这个错能不能变成 hook 规则 / 测试 / lint / 诊断脚本 / 运行时自愈 sweep？能就顺手加一项（`known-issues/` 每条标「回归守卫」，模板见 `_TEMPLATE.md`）。同一个错反复出现 = harness 没补上，不是 agent 没记住。

## 不变量违反时
hook 会拦并指回 `docs/known-issues/architecture-and-migration.md`。若 hook 误伤，调 `.claude/hooks/guard-invariants.py`（warn/block 默认值在那里），别绕过。
