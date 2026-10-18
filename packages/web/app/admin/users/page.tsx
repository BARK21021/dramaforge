"use client";

/**
 * @file admin/users/page.tsx
 * @description 用户管理列表 + 平台指标汇总（对齐 app1 admin/users，批9.5）
 *
 * 顶部 5 张汇总卡：总用户 / 总消耗积分 / 充值总积分 / 用户氪金总金额 / 利润
 * （GET /api/admin/stats）。下方用户列表（GET /api/admin/users，搜索 + 分页），
 * 点行进详情 /admin/users/[userId]。
 *
 * 后端 requireAdmin 做 DB 权威角色守卫；前端 useSession 仅做 UX 门拦 + 跳转。
 * session.user.role 由 server/infra/auth 注入（见 web/lib/auth.ts）。
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Users, Search, TrendingUp, Coins, Wallet, PiggyBank } from "lucide-react";
import { Spinner } from "../../../components/ui/Spinner";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { EmptyState } from "../../../components/ui/EmptyState";
import { useToast } from "../../../components/ui/Toast";

const PAGE_SIZE = 50;

interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  credits: number;
  createdAt: string;
  lastLoginAt: string | null;
  phone: string | null;
}

interface Stats {
  totalUsers: number;
  totalConsumedCredits: number;
  totalRechargedCredits: number;
  totalSpentYuan: number;
  totalCostYuan: number;
  profitYuan: number;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function roleBadge(role: string): string {
  const map: Record<string, string> = {
    ADMIN: "bg-[var(--warning-dim)] text-[var(--warning)]",
    VIP: "bg-[var(--accent-dim)] text-[var(--accent)]",
    FREE: "bg-[var(--bg-hover)] text-[var(--text-2)]",
  };
  return map[role] || "bg-[var(--bg-hover)] text-[var(--text-2)]";
}

function yuan(n: number): string {
  return `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function AdminUsersPage() {
  const router = useRouter();
  const toast = useToast();
  const { data: session, status } = useSession();

  const [users, setUsers] = React.useState<UserRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(false);

  const [qInput, setQInput] = React.useState("");
  const [q, setQ] = React.useState("");

  const [stats, setStats] = React.useState<Stats | null>(null);
  const [statsLoading, setStatsLoading] = React.useState(false);

  // 服务器级并发（RENDER_JOB_SLOTS：客户端 render-worker 全局槽位提示）
  const [renderSlots, setRenderSlots] = React.useState<number | null>(null);
  const [slotsInput, setSlotsInput] = React.useState("");
  const [slotsSaving, setSlotsSaving] = React.useState(false);

  const role = (session?.user as { role?: string } | undefined)?.role ?? "FREE";
  const isAdmin = role === "ADMIN";

  React.useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/auth/signin?callbackUrl=/admin/users");
    } else if (status === "authenticated" && !isAdmin) {
      toast.error("需要管理员权限");
      router.replace("/");
    }
  }, [status, isAdmin, router, toast]);

  // 加载用户列表
  const loadUsers = React.useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (q) params.set("q", q);
      const res = await fetch(`/api/admin/users?${params.toString()}`, { credentials: "include" });
      const data = await res.json();
      if (data.success) {
        setUsers(data.data.users as UserRow[]);
        setTotal(data.data.total as number);
      } else {
        toast.error(data.error || "加载失败");
      }
    } catch (e) {
      toast.error((e as Error)?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [page, q, toast]);

  // 加载平台指标
  const loadStats = React.useCallback(async () => {
    setStatsLoading(true);
    try {
      const res = await fetch("/api/admin/stats", { credentials: "include" });
      const data = await res.json();
      if (data.success) setStats(data.data as Stats);
    } catch {
      // 指标非关键，静默失败
    } finally {
      setStatsLoading(false);
    }
  }, []);

  // 加载服务器并发配置
  const loadConcurrency = React.useCallback(async () => {
    try {
      const res = await fetch("/api/admin/concurrency", { credentials: "include" });
      const data = await res.json();
      if (data.success) {
        setRenderSlots(data.data.renderJobSlots as number);
        setSlotsInput(String(data.data.renderJobSlots));
      }
    } catch {
      // 静默
    }
  }, []);

  /** 保存全局客户端并发槽位（PUT /api/admin/concurrency，1-16 整数） */
  const saveSlots = async () => {
    const n = Number(slotsInput);
    if (!Number.isInteger(n) || n < 1 || n > 16) {
      toast.error("并发槽位必须是 1-16 的整数");
      return;
    }
    setSlotsSaving(true);
    try {
      const res = await fetch("/api/admin/concurrency", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ renderJobSlots: n }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`全局并发槽位已调整为 ${n}`);
        setRenderSlots(n);
      } else {
        toast.error(data.error || "保存失败");
      }
    } catch {
      toast.error("保存失败");
    } finally {
      setSlotsSaving(false);
    }
  };

  React.useEffect(() => {
    if (isAdmin) {
      void loadUsers();
      void loadStats();
      void loadConcurrency();
    }
  }, [isAdmin, loadUsers, loadStats, loadConcurrency]);

  if (status === "loading") {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <Spinner size={28} />
      </main>
    );
  }
  if (!isAdmin) return null;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const handleSearch = () => {
    setPage(1);
    setQ(qInput.trim());
  };

  return (
    <main className="min-h-screen px-6 py-8 max-w-6xl mx-auto">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1
            className="text-2xl font-bold text-[var(--text)] mb-1"
            style={{ fontFamily: "var(--font-display)" }}
          >
            用户管理
          </h1>
          <p className="text-sm text-[var(--text-2)]">共 {total} 人 · 平台运营指标</p>
        </div>
        <Link
          href="/"
          className="text-xs text-[var(--text-3)] hover:text-[var(--text)] transition-colors"
        >
          ← 返回
        </Link>
      </header>

      {/* 平台指标汇总卡（用户明确新加：总消耗积分 / 充值总积分 / 氪金总金额 / 利润 + 总用户）*/}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <StatCard
          icon={<Users size={16} />}
          label="总用户"
          value={stats ? String(stats.totalUsers) : "—"}
        />
        <StatCard
          icon={<TrendingUp size={16} />}
          label="总消耗积分"
          value={stats ? stats.totalConsumedCredits.toLocaleString() : "—"}
          tone="warning"
        />
        <StatCard
          icon={<Coins size={16} />}
          label="充值总积分"
          value={stats ? stats.totalRechargedCredits.toLocaleString() : "—"}
          tone="success"
        />
        <StatCard
          icon={<Wallet size={16} />}
          label="用户氪金"
          value={stats ? yuan(stats.totalSpentYuan) : "—"}
          tone="accent"
        />
        <StatCard
          icon={<PiggyBank size={16} />}
          label="利润"
          value={stats ? yuan(stats.profitYuan) : "—"}
          tone={stats && stats.profitYuan >= 0 ? "success" : "warning"}
          hint={stats ? `成本 ${yuan(stats.totalCostYuan)}` : undefined}
        />
      </div>
      {statsLoading && (
        <div className="text-[10px] text-[var(--text-3)] -mt-4 mb-4">指标加载中…</div>
      )}

      {/* 服务器并发调参（RENDER_JOB_SLOTS 全局提示；每用户并发在用户详情页调） */}
      <div className="card p-3 mb-4 flex items-center gap-3 flex-wrap">
        <div className="text-xs font-bold text-[var(--text-2)]">服务器并发</div>
        <div className="text-[11px] text-[var(--text-3)]">
          客户端 render-worker 全局槽位提示（每用户上限在详情页按 maxConcurrent 调，1-64）
        </div>
        <span className="inline-flex items-center gap-1.5 ml-auto">
          <Input
            type="number"
            min={1}
            max={16}
            value={slotsInput}
            onChange={(e) => setSlotsInput(e.target.value)}
            className="w-20"
            placeholder={renderSlots != null ? String(renderSlots) : "…"}
          />
          <Button variant="primary" size="sm" loading={slotsSaving} onClick={saveSlots}>
            保存
          </Button>
        </span>
      </div>

      {/* 搜索栏 */}
      <div className="flex items-center gap-2 mb-4">
        <Input
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSearch();
          }}
          placeholder="搜索 邮箱 / 手机 / 昵称"
          className="max-w-xs"
          prefix={<Search size={12} />}
        />
        <Button
          variant="primary"
          size="sm"
          onClick={handleSearch}
          loading={loading}
        >
          搜索
        </Button>
        {q && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQ("");
              setQInput("");
              setPage(1);
            }}
          >
            清除
          </Button>
        )}
      </div>

      {/* 用户表 */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-[var(--bg-hover)] text-[var(--text-3)]">
              <tr>
                <th className="text-left px-3 py-2 font-medium">邮箱</th>
                <th className="text-left px-3 py-2 font-medium">手机</th>
                <th className="text-left px-3 py-2 font-medium">昵称</th>
                <th className="text-left px-3 py-2 font-medium">角色</th>
                <th className="text-right px-3 py-2 font-medium">当前积分</th>
                <th className="text-left px-3 py-2 font-medium">注册时间</th>
                <th className="text-left px-3 py-2 font-medium">最近登录</th>
              </tr>
            </thead>
            <tbody>
              {loading && users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-[var(--text-3)]">
                    加载中…
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-[var(--text-3)]">
                    暂无用户
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr
                    key={u.id}
                    onClick={() => router.push(`/admin/users/${u.id}`)}
                    className="border-t border-[var(--border-light)] hover:bg-[var(--bg-hover)] cursor-pointer"
                  >
                    <td className="px-3 py-2 break-all">{u.email}</td>
                    <td className="px-3 py-2">{u.phone || "—"}</td>
                    <td className="px-3 py-2">{u.name || "—"}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${roleBadge(
                          u.role,
                        )}`}
                      >
                        {u.role}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{u.credits}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDate(u.createdAt)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDate(u.lastLoginAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4">
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
    </main>
  );
}

/** 指标卡 */
function StatCard({
  icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "warning" | "success" | "accent";
  hint?: string;
}) {
  const toneCls =
    tone === "warning"
      ? "text-[var(--warning)]"
      : tone === "success"
        ? "text-[var(--success)]"
        : tone === "accent"
          ? "text-[var(--accent)]"
          : "text-[var(--text)]";
  return (
    <div className="card p-3">
      <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-3)] mb-1">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`text-lg font-bold font-mono tabular-nums ${toneCls}`}>{value}</div>
      {hint && <div className="text-[10px] text-[var(--text-3)] mt-0.5">{hint}</div>}
    </div>
  );
}
