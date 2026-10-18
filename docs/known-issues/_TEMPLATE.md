# Known-Issue 模板（postmortem 结构）

> 新建 known-issue 照此结构。**「回归守卫」字段是 harness-engineering 闭环的硬要求**——
> 没有回归守卫 = 这个错下次还会犯，等于没修完。详见 `AGENTS.md` 怎么干活 §6。
>
> Liveness 标注：✅ current（代码核实） · ⚠ stale（代码变了/未部署，待核） · 📦 historical（已解决留档） · ⛔ rejected（否决方案，留档防重提）。

---

## <一句话标题> [✅/⚠/📦/⛔]

**Symptom:** 用户/运维看到的现象。可观测、可复述的外部表现（前端转圈、日志刷错、DB 状态卡住）。

**Root cause:** 真正的根因（不是表象）。点出具体的代码路径 / 状态机漏洞 / 边界条件。一条 issue 一个根因；多根因拆多条。

**Rule / fix:** 改了什么。优先点文件:行（`packages/.../foo.ts:123`），让读者一键跳转。

**回归守卫:** ← **必填**。这个错下次怎么被自动拦住/发现？四选一（或多选）：
- **测试**：`packages/.../foo.test.ts`（测什么行为）
- **hook / lint**：`.claude/hooks/guard-invariants.py`（哪条规则）或某 lint
- **诊断脚本 / 工具**：`scripts/xxx.sh`（让它自动可见）
- **运行时自愈**：某 sweep / reaper / 兜底（路径 + 触发周期）
- **无（仅文档）**：← 这是红灯，尽量补成上面四种之一；实在补不了就说清为什么。

**Live gotcha:** 即时召回的存活陷阱——下次踩同坑前必须知道的、反直觉的那一条（≤3 条）。

**Refs:** `file:line` 证据链 + 关联记忆指针（`[[dramaforge-...]]`）+ 关联 known-issue。

---

## 写作纪律
- **地图非说明书**：根因/修复点到 file:line 即可，别贴大段代码。
- **liveness 随代码漂移**：动工前先读代码复核，⚠ 的尤其。
- **一条一因**：复合故障拆成多条，别混。
- **回归守卫是闭环的落地**：修完顺手补 guard，别只改这一处（见 `AGENTS.md` §6）。
