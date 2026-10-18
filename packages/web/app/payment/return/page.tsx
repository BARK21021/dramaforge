/**
 * @file /payment/return — 支付宝付款后回跳页（P6 移植 F:\app1；P6.1-A UX；P6.2 视觉重做）
 *
 * 读 out_trade_no（或 sessionStorage 兜底），每 2s 轮询 /status，用纯函数
 * classifyPollResponse 归类（见 lib/payment-return-poll.ts）：
 *   - PAID → 清 sessionStorage，显示「+N 积分」，1.5s 后跳 /workspace
 *   - CLOSED/FAILED → 错误提示
 *   - 401 → 登录过期，停轮询，提示重登（不再静默死转）
 *   - 瞬时错误/网络抖动 → 保持轮询
 *   - 5min 超时 → 提示去工作台查余额
 *
 * 始终提供「返回工作台查积分」逃生口：即便用户离开此页，notify + 对账 sweep
 * （payment/sweep）仍保证已支付订单到账——此页只做展示，不替服务器决定发货。
 *
 * P6.2 视觉：从「裸 spinner + 一行字」改成居中状态卡（图标圈 + 标题 + 文案 +
 * 主题按钮），沿用 globals.css 主题变量，与 app 其余卡片一致。
 *
 * Next 16：useSearchParams 必须在 <Suspense> 边界内。默认导出薄服务端包装。
 */
"use client";

import * as React from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Spinner } from "../../../components/ui/Spinner";
import {
  classifyPollResponse,
  pollingMessage,
  paidMessage,
  type PollOutcome,
  type PollResponseBody,
} from "../../../lib/payment-return-poll";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

type Phase = "polling" | "paid" | "closed" | "auth-error" | "timeout";

/** 视觉语调 → 主题色 + 底色（图标圈用） */
type Tone = "pending" | "success" | "warning" | "danger";
const TONE_STYLE: Record<Tone, { color: string; bg: string }> = {
  pending: { color: "var(--action)", bg: "var(--action-dim)" },
  success: { color: "var(--success)", bg: "var(--success-dim)" },
  warning: { color: "var(--warning)", bg: "var(--warning-dim)" },
  danger: { color: "var(--danger)", bg: "rgba(239,68,68,0.14)" },
};

type IconKind = "pending" | "success" | "closed" | "lock" | "clock" | "question";

/** 真正消费 useSearchParams 的客户端内部组件（须被 Suspense 包裹） */
function PaymentReturnInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [phase, setPhase] = React.useState<Phase>("polling");
  const [attempt, setAttempt] = React.useState(0);
  const [credits, setCredits] = React.useState<number | undefined>(undefined);
  const [missing, setMissing] = React.useState(false);

  React.useEffect(() => {
    const outTradeNo = params.get("out_trade_no");
    const orderId = outTradeNo ?? sessionStorage.getItem("pendingPaymentOrderId");
    if (!orderId) {
      setMissing(true);
      return;
    }
    let stopped = false;
    let n = 0;

    const apply = (o: PollOutcome) => {
      switch (o.kind) {
        case "paid":
          stopped = true;
          setCredits(o.credits);
          setPhase("paid");
          try {
            sessionStorage.removeItem("pendingPaymentOrderId");
          } catch {
            // ignore
          }
          setTimeout(() => router.replace("/workspace"), 1500);
          return;
        case "closed":
          stopped = true;
          setPhase("closed");
          return;
        case "auth-error":
          stopped = true;
          setPhase("auth-error");
          return;
        case "pending":
        case "transient-error":
          // 继续轮询
          return;
      }
    };

    const poll = async () => {
      if (stopped) return;
      n += 1;
      setAttempt(n);
      try {
        const resp = await fetch(
          `/api/payment/orders/${encodeURIComponent(orderId)}/status`,
          { credentials: "include" },
        );
        let body: PollResponseBody | null = null;
        try {
          body = (await resp.json()) as PollResponseBody;
        } catch {
          body = null;
        }
        apply(classifyPollResponse(resp.status, body));
      } catch {
        // 网络错误 → 当瞬时，继续轮询
      }
    };

    poll();
    const timer = setInterval(() => {
      if (!stopped) poll();
    }, POLL_INTERVAL_MS);
    const timeout = setTimeout(() => {
      stopped = true;
      setPhase("timeout");
    }, POLL_TIMEOUT_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(timeout);
    };
  }, [params, router]);

  return (
    <ResultCard
      phase={phase}
      attempt={attempt}
      credits={credits}
      missing={missing}
      router={router}
    />
  );
}

/** 按 phase 选标题 */
function titleFor(phase: Phase, missing: boolean): string {
  if (missing) return "未找到订单";
  switch (phase) {
    case "paid":
      return "充值成功";
    case "closed":
      return "订单未完成";
    case "auth-error":
      return "需要重新登录";
    case "timeout":
      return "确认超时";
    case "polling":
    default:
      return "正在确认支付结果";
  }
}

/** 按 phase 选主文案 */
function messageFor(
  phase: Phase,
  attempt: number,
  credits: number | undefined,
  missing: boolean,
): string {
  if (missing) return "未找到订单信息，请返回后重试。";
  switch (phase) {
    case "paid":
      return paidMessage(credits);
    case "closed":
      return "订单已关闭或失败，请重新发起充值。";
    case "auth-error":
      return "登录已过期，请重新登录后查看积分。";
    case "timeout":
      return "确认超时。若你已支付，积分到账后会自动更新——可前往工作台查看余额。";
    case "polling":
    default:
      return pollingMessage(attempt);
  }
}

function toneFor(phase: Phase, missing: boolean): Tone {
  if (missing) return "warning";
  switch (phase) {
    case "paid":
      return "success";
    case "closed":
      return "danger";
    case "auth-error":
    case "timeout":
      return "warning";
    case "polling":
    default:
      return "pending";
  }
}

function iconKindFor(phase: Phase, missing: boolean): IconKind {
  if (missing) return "question";
  switch (phase) {
    case "paid":
      return "success";
    case "closed":
      return "closed";
    case "auth-error":
      return "lock";
    case "timeout":
      return "clock";
    case "polling":
    default:
      return "pending";
  }
}

/** 按 phase 选行动按钮（逃生口 / 重登） */
function actionFor(
  phase: Phase,
  missing: boolean,
  router: ReturnType<typeof useRouter>,
): { label: string; onClick: () => void } | null {
  if (missing || phase === "paid") return null;
  if (phase === "auth-error") {
    return {
      label: "重新登录",
      onClick: () =>
        router.push("/auth/signin?callbackUrl=" + encodeURIComponent("/workspace")),
    };
  }
  return {
    label: "已完成支付，返回工作台",
    onClick: () => router.push("/workspace"),
  };
}

/** 线性描边图标（stroke=currentColor，继承图标圈 color） */
function Icon({ kind }: { kind: Exclude<IconKind, "pending"> }) {
  const common = {
    width: 30,
    height: 30,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (kind) {
    case "success":
      return (
        <svg {...common}>
          <path d="M5 13l4 4L19 7" />
        </svg>
      );
    case "closed":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9 9l6 6M15 9l-6 6" />
        </svg>
      );
    case "lock":
      return (
        <svg {...common}>
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4l3 2" />
        </svg>
      );
    case "question":
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7" />
          <path d="M12 17h.01" />
        </svg>
      );
  }
}

/** 居中状态卡：图标圈 + 标题 + 文案 + 主题按钮 */
function ResultCard({
  phase,
  attempt,
  credits,
  missing,
  router,
}: {
  phase: Phase;
  attempt: number;
  credits: number | undefined;
  missing: boolean;
  router: ReturnType<typeof useRouter>;
}) {
  const tone = toneFor(phase, missing);
  const iconKind = iconKindFor(phase, missing);
  const ts = TONE_STYLE[tone];
  const action = actionFor(phase, missing, router);

  return (
    <main
      className="min-h-screen flex items-center justify-center px-4 py-10"
      style={{ background: "var(--bg)" }}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-8 flex flex-col items-center text-center"
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border-light)",
          boxShadow: "0 12px 36px rgba(0,0,0,0.28)",
        }}
      >
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center mb-5"
          style={{ background: ts.bg, color: ts.color }}
        >
          {iconKind === "pending" ? <Spinner size={28} /> : <Icon kind={iconKind} />}
        </div>
        <h1
          className="text-lg font-semibold mb-2"
          style={{ color: "var(--text-1)" }}
        >
          {titleFor(phase, missing)}
        </h1>
        <p
          className="text-sm leading-relaxed max-w-xs"
          style={{ color: "var(--text-2)" }}
        >
          {messageFor(phase, attempt, credits, missing)}
        </p>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-6 rounded-md px-5 py-2.5 text-sm font-medium text-white"
            style={{
              background:
                "linear-gradient(180deg, var(--action) 0%, var(--action-hover) 100%)",
            }}
          >
            {action.label}
          </button>
        )}
      </div>
    </main>
  );
}

/** 薄包装：为 useSearchParams 提供 Suspense 边界 */
export default function PaymentReturnPage() {
  return (
    <React.Suspense
      fallback={
        <main
          className="min-h-screen flex flex-col items-center justify-center gap-3"
          style={{ background: "var(--bg)" }}
        >
          <Spinner />
          <p className="text-sm" style={{ color: "var(--text-2)" }}>
            正在确认支付结果…
          </p>
        </main>
      }
    >
      <PaymentReturnInner />
    </React.Suspense>
  );
}
