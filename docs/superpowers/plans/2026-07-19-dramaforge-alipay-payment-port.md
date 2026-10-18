# P6 — 支付宝电脑网站支付移植进 dramaforge

> 日期：2026-07-19 ｜ 分支：`feat/cs-ui-slice` ｜ 上游参考：`F:\app1`（07-14 已批准 spec `docs/superpowers/specs/2026-07-14-alipay-credits-recharge-design.md`）
> 状态：设计已批准（本会话用户 "ok"），自驱实现（subagent 仍 429 余额不足）

---

## 0. 背景与纠正

用户问"支付宝呢"。**D:\app1** 是 07-10 过时副本（贴固定二维码 + 管理员人工充值的土法，无真在线支付）；**F:\app1** 是活的（07-14~17 期间已做完真·支付宝 `alipay.trade.page.pay` 跳收银台 + `trade.query` 轮询到账 + `notify` 异步回调验签 + 订单状态机幂等）。用户明确"F:\app1 按照这里面的来"。

**本任务 = 把 F:\app1 这套已批准、已测试的真在线支付，做架构映射移植到 dramaforge。** 不是发明，是搬。

## 1. 范围

| 在 scope | 不在 scope（YAGNI / 后续） |
|---|---|
| page.pay 建单 + 跳转 | 退款 `alipay.trade.refund` |
| trade.query 轮询到账（主路径） | 对账 / 财务报表 |
| notify 异步回调（公网已 HTTPS，生产生效） | 动态二维码当面付（precreate） |
| 订单状态机幂等（PENDING→PAID 原子抢占） | 历史订单数据迁移（payment_orders 不迁） |
| billing 积分发放（creditPurchase） | 动扣费侧已稳定逻辑 |
| CreditsBadge + Modal + /payment/return 前端 | |

## 2. app1 → dramaforge 架构映射

| app1 (Prisma + `@core/*`) | dramaforge (手写 pg + `@dramaforge/*`) |
|---|---|
| `core/payment/client.ts` (AlipaySdk 封装) | `server/src/domain/payment/client.ts` — 几乎原样，仅 env import 改 `@server/infra/env` |
| `core/payment/service.ts` (Prisma) | `server/src/domain/payment/service.ts` — Prisma→repo，调 `payment-order-repo` |
| `core/payment/{types,rules}.ts` | `server/src/domain/payment/{types,rules}.ts` — 原样（rules 的 getEnv 换 dramaforge env） |
| `billing.credit(userId, credits, 'PURCHASE_CREDIT', desc)` | dramaforge 无此方法 → **新增** `billing.creditPurchase(userId, credits, orderId)` |
| `app/api/payment/{orders,orders/[id]/status,notify}/route.ts` | `web/app/api/payment/...` — `requireAuth`→`requireUser`、`apiError`→`apiFail` |
| `app/payment/return/page.tsx` | `web/app/payment/return/page.tsx` — 原样 |
| `PlatformRechargeModal.tsx` (`electronAPI.openExternal`) | dramaforge 版读 `window.sfShell?.openExternal`（需补 IPC） |
| `CreditsBadge.tsx` (轮询 `/api/user/balance`) | dramaforge 版 + **新建** `/api/user/balance` GET 路由 |
| `payment_orders` 表 (Prisma migrate) | `infra/migrations/0002-payment-orders.sql`（手写，自动发现） |

## 3. 关键决策（已定）

1. **payment_orders 不迁数据**。不在 migrate-app1-data.sh 的 14 表内；billing_ledger 已带积分历史。dramaforge 建空表起步，避免 outTradeNo 撞号 / 重复发放。
2. **幂等双保险**：① 订单 `PENDING→PAID` 原子 `UPDATE WHERE status='PENDING'`（rowCount=1 才发）；② dramaforge billing **不为** PURCHASE_CREDIT 加防重放唯一索引（状态机已是单一来源；billing_ledger 现有 `idx_billing_ledger_user_task_type_unique` 是 (userId,taskId,type) 维度，不适用充值）。
3. **billing 补 `creditPurchase(userId, credits, orderId)`**：镜像 `creditRefund` 写法，type=`PURCHASE_CREDIT`、amount=负、credits=正、metadata 带 `{orderId, outTradeNo}`。
4. **sfShell 补 openExternal**：preload 加 IPC 方法 → main `shell.openExternal`；浏览器环境（`window.sfShell` 不存在）回退 `window.location.href`。
5. **env**：`@server/infra/env.ts` 加 `ALIPAY_APP_ID/APP_PRIVATE_KEY/PUBLIC_KEY/GATEWAY/RETURN_URL/NOTIFY_URL`（全 optional，缺则 createOrder 的 config-guard 抛 500）+ `PAYMENT_ORDER_MIN_YUAN`(默认1)/`PAYMENT_ORDER_MAX_YUAN`(默认10000)。
6. **Electron C/S 付款回流**：用户系统浏览器付款 → 回跳 `/payment/return`（系统浏览器内轮询显成功）→ Electron 窗口 CreditsBadge 靠 30s 轮询 + 聚焦事件刷余额。两路都通。
7. **依赖**：`server/package.json` 加 `alipay-sdk`；`outTradeNo` 用 dramaforge `genId`（已是唯一 ID，无需引 uuid）。

## 4. 降级项（移植时 TODO，不阻塞）

- **rate-limit**：app1 orders 路由用 `getRateLimiter`（Redis）限 10 次/60s。dramaforge 无此基建 → 移植时**先不接**，加 `// TODO(rate-limit)` 注释，金额上下限 [1, 10000] + 单用户建单提供基础保护。后续补 Redis rate-limiter。
- **真·支付宝 key 联调**：APPID/私钥/公钥用户暂未提供（app1 设计文档写的 `C:/Users/<user>\Desktop\支付信息.txt` 是另一台机器）。build + 单测不需要 key（config-guard 优雅抛 500）；真 E2E 待用户提供 key 写进服务器 dramaforge `.env`（GC-1）。

## 5. 安全 / 幂等（照搬 app1 spec §9）

- 积分最多发一次：订单 PENDING→PAID 原子转移，notify + 轮询 + 重试均安全。
- 回跳页不可信：发放只认 trade.query（SDK 支付宝公钥验签同步响应）或 notify（checkNotifySign 验签异步推送）；return 纯 UX。
- 归属校验：status 路由校验 `order.userId === session.userId`。
- 金额服务端复核：[PAYMENT_ORDER_MIN_YUAN, PAYMENT_ORDER_MAX_YUAN]。
- outTradeNo 唯一约束：DB UNIQUE。
- 超时关单：PENDING 超 30min 轮询时调 trade.close → CLOSED（保持账本干净）。

## 6. 任务拆分

- **T1** payment_orders 迁移 + types + rules + repo（server）
- **T2** payment client + service + billing creditPurchase + env（server）
- **T3** payment 单测（vi.mock infra+billing，adapt app1 service.test.ts）
- **T4** web 三个 payment API 路由 + /api/user/balance GET
- **T5** client sfShell.openExternal IPC
- **T6** web 前端（Modal + Badge + return 页 + 挂载）
- **T7** typecheck + test + 本地 build + WORKLOG + memory

## 7. 验证标准

- `pnpm -F @dramaforge/server typecheck` + vitest 全过
- `pnpm -F @dramaforge/web typecheck`（含 test）+ vitest 全过
- `pnpm -F @dramaforge/client typecheck`
- 本地 docker build `dramaforge-cs-web:latest` + `dramaforge-cs-ai-worker:latest` 带 P6 成功（不跑真支付，仅验证打包）
- 真 E2E（建单→跳转→付→轮询到账→余额增加）**待 key**，列为 cutover 后验收项

## 8. 文件清单

**新增（server）**：`domain/payment/{client,service,rules,types,repo,index}.ts` + `domain/payment/{service,rules}.test.ts` + `infra/migrations/0002-payment-orders.sql`
**新增（web）**：`app/api/payment/orders/route.ts`、`app/api/payment/orders/[id]/status/route.ts`、`app/api/payment/notify/route.ts`、`app/api/user/balance/route.ts`、`app/payment/return/page.tsx`、`components/ui/PlatformRechargeModal.tsx`、`components/ui/CreditsBadge.tsx` + 测试
**改动**：`server/src/domain/billing/service.ts`（+creditPurchase）、`server/src/domain/billing/index.ts`（导出）、`server/src/infra/env.ts`（+ALIPAY_*）、`client/main/preload.ts`+`ipc-channels.ts`+`index.ts`（+openExternal）、`client/test/shell/preload.test.ts`、`server/package.json`（+alipay-sdk）、web layout（挂 CreditsBadge）
