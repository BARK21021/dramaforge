"use client";

/**
 * @file admin/users/[userId]/page.tsx
 * @description 用户详情（对齐 app1 admin/users/[userId]）
 *
 * 基本信息 + 积分汇总（余额/累计充值/累计消耗）+ 积分明细表（tabs 全部/充值/消耗）
 * + 用户成片只读（AdminUserFilmsSection）+ 手动充值弹窗（POST .../recharge）。
 * 后端 requireAdmin 守卫；前端 useSession 仅 UX 门拦。
 */

import * as React from "react";
import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { Spinner } from "../../../../components/ui/Spinner";
import { Button } from "../../../../components/ui/Button";
import { Input } from "../../../../components/ui/Input";
import { Modal } from "../../../../components/ui/Modal";
import { useToast } from "../../../../components/ui/Toast";
import { AdminUserFilmsSection } from "./AdminUserFilmsSection";

const PAGE_SIZE = 50;
const CREDITS_PER_YUAN = 10;
const MIN_YUAN = 1;
const MAX_YUAN = 10000;

interface UserDetail {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  credits: number;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  phone: string | null;
  maxConcurrent: number;
}
interface Summary {
  totalRecharged: number;
  totalConsumed: number;
}
interface LedgerEntry {
  id: string;
  type: string;
  credits: number;
  balance: number;
  description: string | null;
  createdAt: string;
}
type Tab = "all" | "recharge" | "consume";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function typeMeta(type: string): { label: string; cls: string } {
  switch (type) {
    case "TASK_DEBIT":
      return { label: "消耗", cls: "bg-[var(--warning-dim)] text-[var(--warning)]" };
    case "PURCHASE_CREDIT":
      return { label: "充值", cls: "bg-[var(--success-dim)] text-[var(--success)]" };
    case "ADMIN_CREDIT":
      return { label: "管理员充值", cls: "bg-[var(--success-dim)] text-[var(--success)]" };
    case "QUOTA_CREDIT":
      return { label: "配额", cls: "bg-[var(--accent-dim)] text-[var(--accent)]" };
    case "REFUND_CREDIT":
    case "REFUND":
      // app1 命名是 REFUND_CREDIT；dramaforge creditRefund 实际写 'REFUND'，两者都映射
      return { label: "退款", cls: "bg-[var(--accent-dim)] text-[var(--accent)]" };
    default:
      return { label: type, cls: "bg-[var(--bg-hover)] text-[var(--text-2)]" };
  }
}

export default function AdminUserDetailPage() {
  const router = useRouter();
  const toast = useToast();
  const { status } = useSession();
  const params = useParams();
  const userId = String(params?.userId ?? "");

  const [user, setUser] = React.useState<UserDetail | null>(null);
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const [entries, setEntries] = React.useState<LedgerEntry[]>([]);
  const [ledgerTotal, setLedgerTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [tab, setTab] = React.useState<Tab>("all");
  const [loading, setLoading] = React.useState(true);

  // 手动充值弹窗
  const [rechargeOpen, setRechargeOpen] = React.useState(false);
  const [amountYuan, setAmountYuan] = React.useState("");
  const [note, setNote] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  // 每次打开弹窗生成新 idempotencyKey，服务端据此去重防双击（同一弹窗内重试复用同一 key）
  const idempotencyKeyRef = React.useRef<string>("");

  // 并发上限调参（maxConcurrent = AI 任务槽 + render 认领上限的唯一旋钮）
  const [concurrencyEditing, setConcurrencyEditing] = React.useState(false);
  const [concurrencyInput, setConcurrencyInput] = React.useState("");
  const [concurrencySaving, setConcurrencySaving] = React.useState(false);

  React.useEffect(() => {
    if (status === "unauthenticated") {
      router.replace(`/auth/signin?callbackUrl=/admin/users/${userId}`);
    }
  }, [status, userId, router]);

  const loadDetail = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/users/${userId}`, { credentials: "include" });
      const data = await res.json();
      if (data.success) {
        setUser(data.data.user as UserDetail);
        setSummary(data.data.summary as Summary);
      } else if (res.status === 404) {
        toast.error("用户不存在");
      }
    } catch {
      // 静默
    }
  }, [userId, toast]);

  const loadLedger = React.useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (tab !== "all") params.set("type", tab);
      const res = await fetch(
        `/api/admin/users/${userId}/ledger?${params.toString()}`,
        { credentials: "include" },
      );
      const data = await res.json();
      if (data.success) {
        setEntries(data.data.entries as LedgerEntry[]);
        setLedgerTotal(data.data.total as number);
      }
    } catch {
      // 静默
    } finally {
      setLoading(false);
    }
  }, [userId, page, tab]);

  React.useEffect(() => {
    if (status === "authenticated") {
      void loadDetail();
    }
  }, [status, loadDetail]);
  React.useEffect(() => {
    if (status === "authenticated") {
      void loadLedger();
    }
  }, [status, loadLedger]);

  const submitRecharge = async () => {
    const yuan = Number(amountYuan);
    if (!Number.isFinite(yuan) || yuan < MIN_YUAN) {
      toast.error(`请输入有效金额（≥ ${MIN_YUAN} 元）`);
      return;
    }
    if (yuan > MAX_YUAN) {
      toast.error(`单次充值不能超过 ${MAX_YUAN} 元`);
      return;
    }
    setSubmitting(true);
    try {
      // crypto.randomUUID 在现代浏览器 + HTTPS/localhost 可用；弹窗打开时已生成 key
      const idempotencyKey = idempotencyKeyRef.current || crypto.randomUUID();
      idempotencyKeyRef.current = idempotencyKey;
      const res = await fetch(`/api/admin/users/${userId}/recharge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          amountYuan: yuan,
          note: note.trim() || undefined,
          idempotencyKey,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(
          `充值成功：+${data.data.rechargeCredits} 积分（当前余额 ${data.data.credits}）`,
        );
        setRechargeOpen(false);
        setAmountYuan("");
        setNote("");
        // 关闭弹窗时清空 key，下次重新打开会生成新 key
        idempotencyKeyRef.current = "";
        void loadDetail();
        void loadLedger();
      } else {
        toast.error(data.error || "充值失败");
      }
    } catch (e) {
      toast.error((e as Error)?.message || "充值失败");
    } finally {
      setSubmitting(false);
    }
  };

  /** 保存并发上限（PATCH /api/admin/users/[userId]，1-64 整数） */
  const saveConcurrency = async () => {
    if (!user) return;
    const n = Number(concurrencyInput);
    if (!Number.isInteger(n) || n < 1 || n > 64) {
      toast.error("并发上限必须是 1-64 的整数");
      return;
    }
    setConcurrencySaving(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ maxConcurrent: n }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`并发上限已调整为 ${n}`);
        setConcurrencyEditing(false);
        void loadDetail();
      } else {
        toast.error(data.error || "保存失败");
      }
    } catch {
      toast.error("保存失败");
    } finally {
      setConcurrencySaving(false);
    }
  };

  /** 打开手动充值弹窗：重置表单 + 生成新 idempotencyKey（本次弹窗内重试复用同一 key） */
  const openRecharge = () => {
    setAmountYuan("");
    setNote("");
    idempotencyKeyRef.current =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `ic-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    setRechargeOpen(true);
  };

  if (status === "loading") {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <Spinner size={28} />
      </main>
    );
  }

  const totalPages = Math.max(1, Math.ceil(ledgerTotal / PAGE_SIZE));
  const expectedCredits =
    amountYuan && Number(amountYuan) > 0 ? Math.round(Number(amountYuan) * CREDITS_PER_YUAN) : null;

  return (
    <main className="min-h-screen px-6 py-8 max-w-6xl mx-auto">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/admin/users"
            className="text-xs text-[var(--text-3)] hover:text-[var(--text)] transition-colors"
          >
            ← 用户管理
          </Link>
          <h1
            className="text-xl font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {user?.name || user?.email || "用户详情"}
          </h1>
        </div>
        {user && (
          <Button variant="primary" size="sm" onClick={openRecharge}>
            手动充值
          </Button>
        )}
      </header>

      {/* 基本信息 + 积分汇总 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <div className="card p-4 lg:col-span-2">
          <div className="text-xs font-bold text-[var(--text-2)] mb-3">基本信息</div>
          {user ? (
            <div className="grid grid-cols-2 gap-y-2 text-xs">
              <div>
                <span className="text-[var(--text-3)]">邮箱：</span>
                {user.email || "—"}
              </div>
              <div>
                <span className="text-[var(--text-3)]">手机：</span>
                {user.phone || "—"}
              </div>
              <div>
                <span className="text-[var(--text-3)]">昵称：</span>
                {user.name || "—"}
              </div>
              <div>
                <span className="text-[var(--text-3)]">角色：</span>
                {user.role}
              </div>
              <div>
                <span className="text-[var(--text-3)]">注册时间：</span>
                {formatDate(user.createdAt)}
              </div>
              <div>
                <span className="text-[var(--text-3)]">最近登录：</span>
                {formatDate(user.lastLoginAt)}
              </div>
              <div>
                <span className="text-[var(--text-3)]">最大并发：</span>
                {concurrencyEditing ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={1}
                      max={64}
                      value={concurrencyInput}
                      onChange={(e) => setConcurrencyInput(e.target.value)}
                      className="w-20 inline-block"
                      autoFocus
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      loading={concurrencySaving}
                      onClick={saveConcurrency}
                    >
                      保存
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={concurrencySaving}
                      onClick={() => setConcurrencyEditing(false)}
                    >
                      取消
                    </Button>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    {user.maxConcurrent}
                    <button
                      className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-2)] hover:bg-[var(--border-light)] transition-colors"
                      onClick={() => {
                        setConcurrencyInput(String(user.maxConcurrent));
                        setConcurrencyEditing(true);
                      }}
                    >
                      调参
                    </button>
                  </span>
                )}
              </div>
              <div>
                <span className="text-[var(--text-3)]">更新时间：</span>
                {formatDate(user.updatedAt)}
              </div>
            </div>
          ) : (
            <div className="text-xs text-[var(--text-3)]">加载中…</div>
          )}
        </div>

        <div className="card p-4 space-y-3">
          <div className="text-xs font-bold text-[var(--text-2)]">积分汇总</div>
          <div className="rounded-lg bg-[var(--accent-dim)] p-3">
            <div className="text-[10px] text-[var(--text-3)]">当前余额</div>
            <div className="text-2xl font-bold text-[var(--accent)] font-mono">
              {user?.credits ?? "—"}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-[var(--bg-hover)] p-2">
              <div className="text-[10px] text-[var(--text-3)]">累计充值</div>
              <div className="text-sm font-bold font-mono text-[var(--success)]">
                +{summary?.totalRecharged ?? 0}
              </div>
            </div>
            <div className="rounded-lg bg-[var(--bg-hover)] p-2">
              <div className="text-[10px] text-[var(--text-3)]">累计消耗</div>
              <div className="text-sm font-bold font-mono text-[var(--warning)]">
                -{summary?.totalConsumed ?? 0}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 积分明细 */}
      <div className="card overflow-hidden mb-4">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-light)]">
          <div className="text-xs font-bold text-[var(--text-2)] mr-2">积分明细</div>
          {(["all", "recharge", "consume"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                setPage(1);
              }}
              className={`px-2.5 py-1 rounded text-xs transition-colors ${
                tab === t
                  ? "bg-[var(--action)] text-white"
                  : "bg-[var(--bg-hover)] text-[var(--text-2)] hover:bg-[var(--border-light)]"
              }`}
            >
              {t === "all" ? "全部" : t === "recharge" ? "充值" : "消耗"}
            </button>
          ))}
          <span className="ml-auto text-xs text-[var(--text-3)]">共 {ledgerTotal} 条</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-[var(--bg-hover)] text-[var(--text-3)]">
              <tr>
                <th className="text-left px-3 py-2 font-medium">时间</th>
                <th className="text-left px-3 py-2 font-medium">类型</th>
                <th className="text-left px-3 py-2 font-medium">说明</th>
                <th className="text-right px-3 py-2 font-medium">变动</th>
                <th className="text-right px-3 py-2 font-medium">余额</th>
              </tr>
            </thead>
            <tbody>
              {loading && entries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-[var(--text-3)]">
                    加载中…
                  </td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-[var(--text-3)]">
                    暂无记录
                  </td>
                </tr>
              ) : (
                entries.map((e) => {
                  const m = typeMeta(e.type);
                  const delta = Number(e.credits) || 0;
                  return (
                    <tr key={e.id} className="border-t border-[var(--border-light)]">
                      <td className="px-3 py-2 whitespace-nowrap">{formatDate(e.createdAt)}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${m.cls}`}
                        >
                          {m.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 break-all max-w-md">{e.description || "—"}</td>
                      <td
                        className={`px-3 py-2 text-right font-mono ${
                          delta >= 0 ? "text-[var(--success)]" : "text-[var(--warning)]"
                        }`}
                      >
                        {delta >= 0 ? `+${delta}` : delta}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{e.balance}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 py-3 border-t border-[var(--border-light)]">
            <Button
              variant="ghost"
              size="sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <span className="text-xs text-[var(--text-3)]">
              {page} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              下一页
            </Button>
          </div>
        )}
      </div>

      {/* 用户成片（只读）*/}
      <AdminUserFilmsSection userId={userId} />

      {/* 手动充值弹窗 */}
      <Modal
        open={rechargeOpen}
        onClose={() => {
          if (!submitting) {
            setRechargeOpen(false);
            idempotencyKeyRef.current = "";
          }
        }}
        title="手动充值"
        description={`为 ${user?.email || user?.phone || "该用户"} 充值积分（1 元 = 10 积分）`}
        maxWidthClassName="max-w-md"
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs text-[var(--text-3)] block mb-1">
              金额（元，{MIN_YUAN}–{MAX_YUAN}）
            </label>
            <Input
              type="number"
              min={MIN_YUAN}
              max={MAX_YUAN}
              value={amountYuan}
              onChange={(e) => setAmountYuan(e.target.value)}
              placeholder="如 100"
            />
            {expectedCredits != null && (
              <div className="text-[10px] text-[var(--success)] mt-1">
                ≈ +{expectedCredits} 积分
              </div>
            )}
          </div>
          <div>
            <label className="text-xs text-[var(--text-3)] block mb-1">
              备注（可选）
            </label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="如 付款凭证/渠道"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={submitting}
              onClick={() => {
                setRechargeOpen(false);
                idempotencyKeyRef.current = "";
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={submitting}
              onClick={submitRecharge}
            >
              {submitting ? "提交中…" : "确认充值"}
            </Button>
          </div>
        </div>
      </Modal>
    </main>
  );
}
