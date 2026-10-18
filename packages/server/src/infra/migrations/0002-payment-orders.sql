-- ============================================================
-- 0002-payment-orders.sql — 支付宝充值订单表（P6 新增）
-- ============================================================
-- 支付宝电脑网站支付（alipay.trade.page.pay）的订单状态机中枢。
-- 移植自 app1 payment_orders 表（F:\app1 docs/superpowers/specs/
-- 2026-07-14-alipay-credits-recharge-design.md §5），列名改 snake_case
-- 对齐 dramaforge 新表约定（render_jobs）；repo 层 mapRow 还原驼峰契约。
--
-- 幂等核心：status PENDING→PAID 的原子 UPDATE WHERE status='PENDING'
-- （见 repo.claimPaid），轮询 / notify / 重试三路并发只抢到一次 → 只发一次积分。
--
-- 不迁历史数据：migrate-app1-data.sh 的 14 表不含本表；billing_ledger
-- 已带积分历史，payment_orders 从空表起步（避免 outTradeNo 撞号 / 重复发放）。
-- ============================================================

CREATE TABLE IF NOT EXISTS payment_orders (
  id            TEXT        PRIMARY KEY,                       -- 订单 ID（genId）
  out_trade_no  TEXT        NOT NULL UNIQUE,                   -- 商户订单号，传给支付宝（唯一约束防撞号）
  user_id       TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_yuan   NUMERIC(10,2) NOT NULL,                        -- 付款金额（元）
  credits       INTEGER     NOT NULL,                          -- 应到账积分（= amount_yuan * 10）
  status        TEXT        NOT NULL DEFAULT 'PENDING',        -- PENDING / PAID / CLOSED / FAILED
  trade_no      TEXT,                                          -- 支付宝交易号（查单/回调后回填）
  pay_url       TEXT,                                          -- page.pay 跳转链接（调试用）
  paid_at       TIMESTAMPTZ,                                   -- 到账时间
  credited_at   TIMESTAMPTZ,                                   -- 积分发放时间
  ledger_id     TEXT,                                          -- 关联 billing_ledger 条目
  metadata      JSONB,                                         -- 错误信息 / 原始响应
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 加速按用户查历史订单 + 按状态扫待处理单
CREATE INDEX IF NOT EXISTS idx_payment_orders_user   ON payment_orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status, created_at);
