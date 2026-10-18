# docs/ 索引（System of Record）

> 全 docs 编目 + 校验状态。先读 [`../AGENTS.md`](../AGENTS.md) 定方向，深查来这。
> **校验状态**：✅ current（代码核实） · ⚠ stale（代码变了/未部署，待核） · 📦 historical（设计期/已解决，留档） · 🔒 被机制强制
>
> _记于 2026-07-27 harness-engineering 改造。校验状态随代码漂移，doc-gardening 周期复核。_

## 顶层
| 文档 | 状态 | 说明 |
|------|------|------|
| `deploy-history.md` | 📦 | dramaforge 云端部署续N 全历史（30 段，94KB），newest-first。当前态见记忆指针 `dramaforge-cloud-deploy-state` |
| `refactor-history.md` | 📦 | dramaforge C/S 重构过程状态历史（续9-20 + 07-18 侦察，35KB），newest-first。设计/计划见 `superpowers/` |
| `ops-access.md` | ✅ | SSH 接入 / deploy.sh / rollback.sh / publish-client.sh 命令 + 坑 |
| `version-update-runbook.md` | ✅ | 客户端发版（build/package/publish）runbook |
| `REPLICATE-APP1-PLAN.md` | ✅ | 复刻 app1 的 10 批路线 + 缺口分析 |
| `prompt-alignment-audit.md` | ⚠ | 提示词对齐审计（07-23，需对当前 prompt 复核） |
| `HANDOFF.md` | 📦 | 07-20 交接（历史） |
| `HANDOFF-STATUS.md` | 📦 | 07-21 cutover 状态（1.1.2 全量交接，历史） |
| `CUTOVER-RUNBOOK.md` | 📦 | cutover 操作 runbook（历史，发版走 `version-update-runbook.md`） |
| `ops/minio-public-ingress.md` | ⚠ | MinIO 公网入口——关联 H1 遗留债（服务器存储层未清退） |
| `local-deployment.md` | ✅ | 本地版部署策略：一套代码两种打包 + spike 证完 + 防盗版闭环 + 启动隔离 + 待办 |

## archive/（历史大日志，📦）
| 文档 | 说明 |
|------|------|
| `archive/WORKLOG.md` | 项目时间线主记录（续NN，168KB）——边做边写的抗 compact 日志 |

## known-issues/（存活规则 + 根因 + 即时召回 gotcha）
| 文档 | 状态 | 说明 |
|------|------|------|
| `architecture-and-migration.md` | 🔒 | **硬约束 H1/H2/H3** + app1 迁移政策 + 迁移类已知坑。H1⚠ 部分成立（单镜头遗留债） |
| `chain-fakedeath.md` | ✅ | chain 编排 / 假死 / 计费死循环（11 issue，含 1.1.17 已被 1.1.18 取代） |
| `continuity-prompt.md` | ✅ | 镜头连续性 / 提示词 / 资产变体（13 issue，含 ⛔否决的 endState 台账 + 3 项⚠未部署） |
| `billing-security.md` | ✅ | 计费资损修复 / 安全审计 / provider 约束（12 issue，含 Ed25519 签名阶段2⚠待用户） |

## recon/（设计期侦察，📦 historical）
P5 合片 / 批2 EpisodeWorkspace-SSE / 批3 input / 批4 analyzing / 批5 assets / 批6 storyboard / 批7 production / 批8 films / 转绘 X3 整剧重写 / 转绘 video-to-script。设计期产物，实现后留档参考。

## reports/（压测 + 实现报告，📦 historical）
2026-07-22 production-capacity-stress-test / 批4 / 批6 / 批7 / 批8 impl-report。

## superpowers/
| 文档 | 状态 | 说明 |
|------|------|------|
| `specs/2026-07-28-asset-master-and-storyboard-structured-design.md` | ✅ | 资产总表+按集查看（出场集 shots 派生）+ 分镜结构化提示词/资产约束，全栈对齐参考截图（渐进式 C，Phase3 三栏可选） |
| `specs/2026-07-27-harness-engineering-design.md` | ✅ | 本次 harness-engineering 改造设计（一刀切 A 方案） |
| `specs/2026-07-25-storyboard-duration-and-shot-numbering-design.md` | ✅ | 分镜时长/编号设计 |
| `specs/2026-07-18-cs-refactor-design.md` | 📦 | C/S 重构初始设计 |
| `plans/*.md` | 📦/✅ | cs-ui-vertical-slice P1-P7 / alipay / storyboard / cs-refactor 执行计划 |

---
## scripts/（运维脚本 = 机械化的回归守卫）
| 脚本 | 状态 | 说明 |
|------|------|------|
| `scripts/diagnose-stuck-chain.sh` | ✅ | chain 假死一键诊断（交叉验 claim 硬上限 + 日志 + 扣费 + result）。用法见 `ops-access.md` §诊断卡死链；背景见 `known-issues/chain-fakedeath.md` |

---

**怎么用**：改某模块前，先 grep 本索引 + `known-issues/` 找相关存活规则；记忆里 dramaforge-* 只是薄指针。校验状态 ⚠ 的动工前必须读代码复核。
