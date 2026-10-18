# Harness-Engineering 改造设计（方案 A · 一刀切）

> 2026-07-27 · 依据 OpenAI《Engineering the Harness》（Ryan Lopopolo）· 状态：执行中

## 背景：为什么要做

对照文章原则诊断当前 Claude 工作区，发现记忆层严重违背"地图非说明书"：

- 单文件 `dramaforge-cloud-deploy-state.md` **104KB / 542 行 / 53 段"续N"**，`description` 字段自己就 12KB。一次 recall 把 10 万字节的历史部署流水账灌进上下文。
- `MEMORY.md` 65 行，每条 300-400 字叙事。索引本身成了说明书。
- 硬约束（资产只本地 / key 只在云 / 前端照搬 app1）**只活在散文记忆里**，`settings.json` **零 hook**——未来 agent 一旦没 recall 就会被违反。
- dramaforge 知识全塞在记忆 blob 里，`D:\dramaforge-cs` 无 AGENTS.md、无 docs 索引，知识不可导航。

文章核心论点：**人类掌舵（设计环境、明确意图、建反馈回路），智能体执行**。知识要推到 repo（agent 运行时看不到的等于不存在），不变量要机械强制（linter/hook，非散文微观管理），技术债像高息贷款要连续偿还。

## 总原则（贯穿全改造）

1. **地图非说明书**——上下文是稀缺资源，巨大指令文件会挤掉任务本身。
2. **不变量机械强制**——linter/hook，错误信息内嵌修复指令；散文只做边界提醒。
3. **技术债 = 高息贷款**——连续小额偿还，反对"周五集中大清场"。
4. **repo 是真相源，记忆只是指针**——决策/部署/历史日志是 repo 的版本化工件。
5. **所有改动可逆**；任何"删除"前内容必先迁 repo，零知识丢失。
6. **绝不碰 42 个脏 tracked 文件，绝不擅自 commit**；所有 repo 工作 = 新增 untracked 文件。

## 改造产物

### A. 记录系统（repo，新增 untracked）
| 文件 | 作用 |
|---|---|
| `AGENTS.md` | ~100 行地图：dramaforge 是什么 / 架构分层 / 硬约束指针 / 东西在哪 / 指向 docs/INDEX.md |
| `docs/INDEX.md` | 全 docs 编目 + 校验状态（✅/⚠/📦） |
| `docs/deploy-history.md` | 104KB 续N 部署历史（从记忆迁出，newest-first） |
| `docs/ops-access.md` | SSH 接入 / 部署 / 回滚命令 |
| `docs/known-issues/chain-fakedeath.md` | chain/假死/计费死循环集群（8 记忆合并） |
| `docs/known-issues/continuity-prompt.md` | 连续性/提示词/资产变体集群（13 记忆） |
| `docs/known-issues/architecture-and-migration.md` | 架构硬约束/app1 迁移/已知坑（10 记忆） |
| `docs/known-issues/billing-security.md` | 计费/安全/provider 集群（5 记忆） |

### B. 不变量机械强制（repo 内，随仓库走）
- `.claude/settings.json` — PostToolUse hook（Edit|Write）
- `.claude/hooks/guard-invariants.py` — 扫 `packages/server/**` 媒体字节入库 → block；扫 `packages/client/**` 裸 AI key → block；默认 warn。错误信息指回硬约束文档。
- ⚠ 仅在 `cwd=D:\dramaforge-cs` 启动 Claude Code 时生效。

### C. 记忆层（瘦身后）
- 每个 dramaforge-* 记忆 → 薄指针（一行 desc + repo 路径 + ≤2 条即时召回存活 gotcha）
- 完全吸收、无 live gotcha 的删除
- `MEMORY.md` → ≤120 字一行 hook

### D. 基石 + 反馈回路
- `harness-engineering-principles.md`（reference 记忆）——防回归楔石，未来会话继承纪律
- doc-gardening cron——周期扫腐烂（>5KB 文件 / 续N 增长 / 索引行 >150 字）+ 每次偿还一项

## 执行顺序（一刀切）
1. 并行派 5 子 agent 做集群合并（deploy-history / chain / continuity / architecture / billing-security），faithful 核验代码标 liveness
2. 建 AGENTS.md + hooks + 基石（主 agent，与子 agent 并行）
3. 子 agent 返回后：建 INDEX.md + 瘦身记忆 + 压缩 MEMORY.md
4. 起 doc-gardening cron

## 风险与缓解
- **版本号对不上**：memory（续62 / 6938f09）与 git HEAD（5f6119f）不一致，抽取当前态时一律标注"⚠待核"，不把未验状态当事实写死。
- **项目 hook 作用域**：只在 cwd=dramaforge 时生效；全局 `~/.claude/settings.json` 保持最小不动。
- **faithful 合并**：子 agent 须读记忆 + 核代码标 liveness，已解决的标📦，被否决的（如 endState 台账）标⛔防再提。
- **不丢知识**：所有删除前内容已迁 repo；记忆薄指针保留即时召回的存活 gotcha。

## 验收
- [ ] `dramaforge-cloud-deploy-state.md` 104KB → <3KB，历史全在 repo
- [ ] MEMORY.md 每行 ≤120 字
- [ ] AGENTS.md ≤100 行，是地图非百科
- [ ] docs/INDEX.md 覆盖全部 docs 含校验状态
- [ ] guard-invariants.py 能拦 server 媒体入库 + client 裸 key，默认不误伤
- [ ] harness-engineering-principles.md 入索引
- [ ] doc-gardening cron 已起
