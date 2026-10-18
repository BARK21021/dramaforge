"use client";

/**
 * @file ApiKeyPoolCard.tsx — 平台 API Key 池管理卡（admin-only，挂在 settings 页）
 *
 * dramaforge C/S：平台统一持 key（GC-1），此卡用于 admin 增/删/改/测/启停各 provider
 * 的平台 Key，后端按 weight 做加权轮询、失败自动冷却。
 *
 * Admin 门：复制 AppSidebar.tsx lines 98-100 的 useSession 三态写法。
 * 仅当 status === 'authenticated' && session?.user?.role === 'ADMIN' 时渲染；
 * 否则返回 null（非 admin 用户在 settings 页根本看不到此卡）。
 *
 * 视觉：对齐 settings 页其他卡（card card-pad / 11x11 rounded-2xl 图标容器 /
 * var(--*) theme tokens）。UI 原语全用现有 @dramaforge/web 组件
 * （Button/Input/Spinner/useToast/ConfirmDialog/EmptyState/cn/useAuthFetch），
 * 不重造。
 *
 * API 契约（与后端 api-configs 路由并行开发，见任务说明）：
 *   GET    /api/admin/api-configs         → { configs: ApiConfigView[] }
 *   POST   /api/admin/api-configs         body {provider,apiKey,label?,weight?,baseUrl?}
 *                                          → { config: ApiConfigView }
 *   PATCH  /api/admin/api-configs/[id]    body {label?,weight?,isEnabled?,baseUrl?,keyStatus?}
 *                                          → { config: ApiConfigView }
 *   DELETE /api/admin/api-configs/[id]    → { ok: true }
 *   GET    /api/admin/api-configs/[id]/secret → { apiKey: string }（管理员按条查看）
 *   POST   /api/admin/api-configs/test    body {configId}
 *                                          → { ok: boolean, message: string }
 *
 * 安全约束：
 *   - apiKey 输入恒为 type="password"；完整值仅在管理员主动按条查看时短暂显示；
 *   - 列表只展示后端返回的 apiKeyMasked（如 sk-****1234）；
 *   - 编辑表单允许输入新 Key，但空值表示保留；后端响应仍只返回掩码。
 */

import * as React from "react";
import { useSession } from "next-auth/react";
import {
  KeyRound,
  Plus,
  Pencil,
  Trash2,
  RotateCcw,
  Zap,
  Power,
  Eye,
  EyeOff,
  X,
} from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Spinner } from "../ui/Spinner";
import { useToast } from "../ui/Toast";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState } from "../ui/EmptyState";
import { useAuthFetch } from "../../hooks/useAuthFetch";
import {
  getProviderMeta,
  PROVIDER_KEYS,
  PROVIDER_CAPABILITY_LABELS,
} from "../../lib/providers";

// ============================================================
// 类型（对齐后端 ApiConfigView 契约）
// ============================================================

type KeyStatus = "active" | "cooldown" | "disabled" | "invalid";

interface ApiConfigView {
  id: string;
  provider: string;
  label: string | null;
  apiKeyMasked: string;
  baseUrl: string | null;
  weight: number;
  isEnabled: boolean;
  keyStatus: KeyStatus;
  lastUsedAt: string | null;
  errorCount: number;
  consecutiveFailures: number;
  disabledUntil: string | null;
  lastErrorMessage: string | null;
  /** 单 key 并发上限；null=不限（运行时 pick() 按 ?? Infinity 放行） */
  maxConcurrent: number | null;
}

interface ApiConfigBalanceView {
  configId: string;
  balanceSupported: boolean;
  balanceLabel?: string;
  error?: string;
  lastUpdated: string;
}

/** GC-4 API 成功 envelope。组件过去直接读顶层字段，导致 Key 列表永远显示为空。 */
interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

// ============================================================
// 工具
// ============================================================

/**
 * 状态徽章：返回 {text, cls, title}，cls 走 globals.css 的 .badge-* 类。
 * 颜色映射（spec）：
 *   active   → success 绿
 *   cooldown → accent 橙（disabledUntil tooltip）
 *   disabled → muted 灰（text-3）
 *   invalid  → error 红（lastErrorMessage tooltip）
 */
function statusBadge(c: ApiConfigView): { text: string; cls: string; title?: string } {
  switch (c.keyStatus) {
    case "active":
      return { text: "可用", cls: "badge-success" };
    case "cooldown":
      return {
        text: "冷却中",
        cls: "badge-accent",
        title: c.disabledUntil
          ? `恢复时间: ${new Date(c.disabledUntil).toLocaleString("zh-CN", { hour12: false })}`
          : "等待自动恢复",
      };
    case "disabled":
      return { text: "已禁用", cls: "badge-muted" };
    case "invalid":
      return {
        text: "失效",
        cls: "badge-error",
        title: c.lastErrorMessage ?? "认证失败，需修复后重新启用",
      };
    default:
      return { text: "未知", cls: "badge-muted" };
  }
}

/**
 * 相对时间格式化（"3 分钟前"），超过 7 天回退 ISO 日期。
 */
function formatRelative(iso: string | null): string {
  if (!iso) return "从未使用";
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return iso;
    const diff = Math.max(0, Date.now() - t);
    const min = Math.floor(diff / 60_000);
    if (min < 1) return "刚刚";
    if (min < 60) return `${min} 分钟前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d} 天前`;
    return new Date(iso).toLocaleDateString("zh-CN");
  } catch {
    return iso;
  }
}

/**
 * 解析并发上限输入框：空串/非正/非数 → null（不限）；否则正整数 floor。
 * 与后端 service.normalizeMaxConcurrent 同语义（UI 提前归一，传 number|null）。
 */
function parseMaxConcurrentInput(s: string): number | null {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

// ============================================================
// 主组件
// ============================================================

/**
 * 顶层导出：admin 门 + Inner。
 *
 * 门与 Inner 拆开是为了让 Inner 的所有 hooks（useToast/useAuthFetch/useEffect…）
 * 在挂载后保持顺序稳定——如果直接在外层加 `if (!isAdmin) return null` 然后再
 * 调 hooks，会触发 React hooks 顺序违规告警。
 */
export function ApiKeyPoolCard() {
  const { data: session, status } = useSession();
  const isAdmin = status === "authenticated" && session?.user?.role === "ADMIN";

  // 非 admin：不渲染任何 DOM（settings 页正常用户看不到此卡）
  if (!isAdmin) return null;

  return <ApiKeyPoolCardInner />;
}

function ApiKeyPoolCardInner() {
  const toast = useToast();
  const { authFetch } = useAuthFetch();

  const [configs, setConfigs] = React.useState<ApiConfigView[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [showAddForm, setShowAddForm] = React.useState(false);
  const [importing, setImporting] = React.useState(false);

  // 添加表单字段
  const [addProvider, setAddProvider] = React.useState("kimi");
  const [addApiKey, setAddApiKey] = React.useState("");
  const [addLabel, setAddLabel] = React.useState("");
  const [addWeight, setAddWeight] = React.useState(1);
  const [addMaxConcurrent, setAddMaxConcurrent] = React.useState("");
  const [addBaseUrl, setAddBaseUrl] = React.useState("");
  const [adding, setAdding] = React.useState(false);

  // 内联编辑
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editLabel, setEditLabel] = React.useState("");
  const [editWeight, setEditWeight] = React.useState(1);
  const [editMaxConcurrent, setEditMaxConcurrent] = React.useState("");
  const [editBaseUrl, setEditBaseUrl] = React.useState("");
  /** 留空保留原 Key；管理员输入新值才会替换，明文不会从服务端回显。 */
  const [editApiKey, setEditApiKey] = React.useState("");
  const [editIsEnabled, setEditIsEnabled] = React.useState(true);
  const [savingEdit, setSavingEdit] = React.useState(false);

  // 删除确认
  const [deleteTarget, setDeleteTarget] = React.useState<ApiConfigView | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  // 行级忙碌（重置 / 启停）防重复点击，并精确标记触发中的按钮。
  const [busyAction, setBusyAction] = React.useState<{ id: string; kind: "reset" | "toggle" } | null>(null);
  // 测试中
  const [testingId, setTestingId] = React.useState<string | null>(null);
  // 测试结果按 id 索引
  const [testResults, setTestResults] = React.useState<
    Record<string, { ok: boolean; message: string }>
  >({});
  const [balances, setBalances] = React.useState<Record<string, ApiConfigBalanceView>>({});
  const [loadingBalances, setLoadingBalances] = React.useState(false);
  /** 明文仅在管理员主动查看后保存在当前页面内存中，刷新列表即清除。 */
  const [revealedKeys, setRevealedKeys] = React.useState<Record<string, string>>({});
  const [revealingId, setRevealingId] = React.useState<string | null>(null);

  // -------- 拉取列表 --------

  const loadConfigs = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    // 任何刷新、增删改后都重新隐藏明文，避免旧凭证继续留在界面状态里。
    setRevealedKeys({});
    try {
      const res = await authFetch("/api/admin/api-configs");
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data?.error || `加载失败（${res.status}）`);
      }
      const envelope = (await res.json()) as ApiEnvelope<ApiConfigView[]>;
      // 排序：按 provider 字母序，同 provider 内 isEnabled 优先
      const sorted = [...(envelope.data ?? [])].sort((a, b) => {
        const p = a.provider.localeCompare(b.provider);
        if (p !== 0) return p;
        if (a.isEnabled !== b.isEnabled) return a.isEnabled ? -1 : 1;
        return 0;
      });
      setConfigs(sorted);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  /** 余额与配置列表分开加载，避免不支持余额的 provider 阻塞 Key CRUD。 */
  const loadBalances = React.useCallback(async () => {
    setLoadingBalances(true);
    try {
      const response = await authFetch('/api/admin/api-configs/balances');
      if (!response.ok) throw new Error(`余额查询失败（${response.status}）`);
      const envelope = await response.json() as ApiEnvelope<ApiConfigBalanceView[]>;
      setBalances(Object.fromEntries((envelope.data ?? []).map((item) => [item.configId, item])));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '余额查询失败');
    } finally {
      setLoadingBalances(false);
    }
  }, [authFetch, toast]);

  React.useEffect(() => {
    void loadConfigs();
  }, [loadConfigs]);

  React.useEffect(() => {
    // 管理员打开设置页时自动加载一次余额，按钮仍可用于手动刷新。
    void loadBalances();
  }, [loadBalances]);

  // -------- 添加 --------

  const resetAddForm = () => {
    setAddProvider("kimi");
    setAddApiKey("");
    setAddLabel("");
    setAddWeight(1);
    setAddMaxConcurrent("");
    setAddBaseUrl("");
  };

  /**
   * 本地解析常见的“标签 + Key”文本。只识别明确 provider；阿里云 AK/SK 不等于
   * DashScope Bearer Key，因此不会仅凭“阿里”二字误导入。
   */
  const parseKeyFile = (text: string): Array<{ provider: string; apiKey: string; label: string }> => {
    const providerOf = (line: string): string | null => {
      const lower = line.toLowerCase();
      if (lower.includes('kimi') || lower.includes('moonshot')) return 'kimi';
      if (lower.includes('deepseek')) return 'deepseek';
      if (lower.includes('火山') || /\bark\b/.test(lower)) return 'ark';
      return null;
    };
    const result: Array<{ provider: string; apiKey: string; label: string }> = [];
    let pendingProvider: string | null = null;
    let pendingLabel = '';
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      const provider = providerOf(line) ?? pendingProvider;
      const tokens = line.match(/[A-Za-z0-9_\-.]{20,}/g) ?? [];
      // 排除纯数字标签；只导入已明确识别为 Kimi/DeepSeek/ARK 的长凭证。
      const apiKey = tokens.find((token) => !/^\d+$/.test(token));
      if (provider && apiKey) {
        result.push({ provider, apiKey, label: pendingLabel || line.replace(apiKey, '').trim().slice(0, 80) });
        pendingProvider = null;
        pendingLabel = '';
      } else {
        const explicit = providerOf(line);
        if (explicit) {
          pendingProvider = explicit;
          pendingLabel = line.slice(0, 80);
        }
      }
    }
    const unique = new Map<string, { provider: string; apiKey: string; label: string }>();
    for (const item of result) unique.set(`${item.provider}\u0000${item.apiKey}`, item);
    return [...unique.values()];
  };

  const handleImportFile = async (file: File) => {
    setImporting(true);
    try {
      const items = parseKeyFile(await file.text());
      if (items.length === 0) throw new Error('没有识别到可安全导入的 Key');
      const response = await authFetch('/api/admin/api-configs/import', {
        method: 'POST',
        body: JSON.stringify({ items }),
      });
      const envelope = await response.json().catch(() => ({})) as Partial<ApiEnvelope<{
        imported: ApiConfigView[];
        skippedDuplicates: number;
      }>> & { error?: string };
      if (!response.ok) throw new Error(envelope.error || `导入失败（${response.status}）`);
      toast.success(`已导入 ${envelope.data?.imported.length ?? 0} 个 Key，跳过 ${envelope.data?.skippedDuplicates ?? 0} 个重复项`);
      await Promise.all([loadConfigs(), loadBalances()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const handleAdd = async () => {
    const provider = addProvider.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) {
      toast.error("服务商标识只能使用字母、数字、点、下划线或短横线");
      return;
    }
    const apiKey = addApiKey.trim();
    if (!apiKey) {
      toast.error("请输入 API Key");
      return;
    }
    const weight = Math.max(1, Math.floor(addWeight));
    if (!Number.isFinite(addWeight) || addWeight < 1) {
      toast.error("权重需为正整数");
      return;
    }
    setAdding(true);
    try {
      const res = await authFetch("/api/admin/api-configs", {
        method: "POST",
        body: JSON.stringify({
          provider,
          apiKey,
          label: addLabel.trim() || undefined,
          weight,
          maxConcurrent: parseMaxConcurrentInput(addMaxConcurrent),
          baseUrl: addBaseUrl.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data?.error || `添加失败（${res.status}）`);
      }
      toast.success(`已添加 ${provider} Key`);
      resetAddForm();
      setShowAddForm(false);
      await Promise.all([loadConfigs(), loadBalances()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "添加失败");
    } finally {
      setAdding(false);
    }
  };

  // -------- 编辑 --------

  const startEdit = (c: ApiConfigView) => {
    setEditingId(c.id);
    setEditLabel(c.label ?? "");
    setEditWeight(c.weight);
    setEditMaxConcurrent(c.maxConcurrent != null ? String(c.maxConcurrent) : "");
    setEditBaseUrl(c.baseUrl ?? "");
    setEditApiKey("");
    setEditIsEnabled(c.isEnabled);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditApiKey("");
  };

  const handleSaveEdit = async (c: ApiConfigView) => {
    const weight = Math.max(1, Math.floor(editWeight));
    if (!Number.isFinite(editWeight) || editWeight < 1) {
      toast.error("权重需为正整数");
      return;
    }
    setSavingEdit(true);
    try {
      const body: Record<string, unknown> = {};
      if (editLabel.trim() !== (c.label ?? "")) body.label = editLabel.trim() || null;
      if (weight !== c.weight) body.weight = weight;
      const newMax = parseMaxConcurrentInput(editMaxConcurrent);
      if (newMax !== c.maxConcurrent) body.maxConcurrent = newMax;
      if (editBaseUrl.trim() !== (c.baseUrl ?? "")) body.baseUrl = editBaseUrl.trim() || null;
      if (editIsEnabled !== c.isEnabled) body.isEnabled = editIsEnabled;
      if (editApiKey.trim()) body.apiKey = editApiKey.trim();

      const res = await authFetch(`/api/admin/api-configs/${c.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data?.error || `保存失败（${res.status}）`);
      }
      toast.success("已保存");
      setEditingId(null);
      setEditApiKey("");
      await Promise.all([loadConfigs(), loadBalances()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSavingEdit(false);
    }
  };

  // -------- 删除 --------

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await authFetch(`/api/admin/api-configs/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data?.error || `删除失败（${res.status}）`);
      }
      toast.success(`已删除 ${deleteTarget.provider} Key`);
      setDeleteTarget(null);
      await loadConfigs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  // -------- 重置状态 --------

  const handleResetStatus = async (c: ApiConfigView) => {
    if (busyAction) return;
    setBusyAction({ id: c.id, kind: "reset" });
    try {
      const res = await authFetch(`/api/admin/api-configs/${c.id}/reset`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data?.error || `重置失败（${res.status}）`);
      }
      toast.success("状态已重置");
      await loadConfigs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "重置失败");
    } finally {
      setBusyAction(null);
    }
  };

  // -------- 切换启用 --------

  const handleToggleEnabled = async (c: ApiConfigView) => {
    if (busyAction) return;
    setBusyAction({ id: c.id, kind: "toggle" });
    try {
      const res = await authFetch(`/api/admin/api-configs/${c.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isEnabled: !c.isEnabled }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data?.error || `切换失败（${res.status}）`);
      }
      toast.success(`已${c.isEnabled ? "禁用" : "启用"}`);
      await loadConfigs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "切换失败");
    } finally {
      setBusyAction(null);
    }
  };

  // -------- 测试连通 --------

  const handleTest = async (c: ApiConfigView) => {
    setTestingId(c.id);
    try {
      const res = await authFetch("/api/admin/api-configs/test", {
        method: "POST",
        body: JSON.stringify({ configId: c.id }),
      });
      const envelope = (await res.json().catch(() => ({}))) as Partial<ApiEnvelope<{
        ok: boolean;
        message: string;
      }>> & {
        error?: string;
      };
      if (!res.ok) {
        const msg = envelope?.error || `测试失败（${res.status}）`;
        setTestResults((prev) => ({ ...prev, [c.id]: { ok: false, message: msg } }));
        toast.error(msg);
      } else {
        const ok = Boolean(envelope.data?.ok);
        const message =
          typeof envelope.data?.message === "string" && envelope.data.message
            ? envelope.data.message
            : ok
              ? "连接成功"
              : "连接失败";
        setTestResults((prev) => ({ ...prev, [c.id]: { ok, message } }));
        if (ok) toast.success(`${c.provider} 连接成功`);
        else toast.error(`${c.provider} 连接失败：${message}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "网络错误";
      setTestResults((prev) => ({ ...prev, [c.id]: { ok: false, message: msg } }));
      toast.error(msg);
    } finally {
      setTestingId(null);
    }
  };

  /** 管理员显式显示/隐藏单条 Key；常规列表接口不会批量返回明文。 */
  const handleReveal = async (c: ApiConfigView) => {
    if (revealedKeys[c.id]) {
      setRevealedKeys((current) => {
        const next = { ...current };
        delete next[c.id];
        return next;
      });
      return;
    }
    setRevealingId(c.id);
    try {
      const response = await authFetch(`/api/admin/api-configs/${c.id}/secret`, {
        cache: 'no-store',
      });
      const envelope = await response.json().catch(() => ({})) as Partial<
        ApiEnvelope<{ apiKey: string }>
      > & { error?: string };
      if (!response.ok || !envelope.data?.apiKey) {
        throw new Error(envelope.error || `读取 Key 失败（${response.status}）`);
      }
      setRevealedKeys((current) => ({ ...current, [c.id]: envelope.data!.apiKey }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取 Key 失败');
    } finally {
      setRevealingId(null);
    }
  };

  // -------- 派生：按 provider 分组 --------

  const groups = React.useMemo(() => {
    const map = new Map<string, ApiConfigView[]>();
    for (const c of configs) {
      const arr = map.get(c.provider) ?? [];
      arr.push(c);
      map.set(c.provider, arr);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [configs]);

  const activeCount = configs.filter(
    (c) => c.keyStatus === "active" && c.isEnabled,
  ).length;
  const problemCount = configs.filter(
    (c) => c.keyStatus === "invalid" || c.keyStatus === "cooldown",
  ).length;

  // ============================================================
  // 渲染
  // ============================================================

  return (
    <section className="card card-pad mb-6 sm:mb-8">
      {/* 卡片头：图标 + 标题 + 副标题 + 计数 + 操作 */}
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-11 h-11 rounded-2xl bg-[var(--accent-dim)] flex items-center justify-center flex-shrink-0">
            <KeyRound size={22} className="text-[var(--accent)]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold text-[var(--text)]">API Key 池</h2>
              <span className="badge badge-accent text-[10px]">管理员</span>
              {configs.length > 0 && (
                <span className="text-xs text-[var(--text-3)]">
                  共 {configs.length} 个 · {activeCount} 可用
                  {problemCount > 0 && (
                    <span className="text-[var(--error)]"> · {problemCount} 异常</span>
                  )}
                </span>
              )}
            </div>
            <p className="text-xs text-[var(--text-3)] mt-0.5">
              平台各 AI 服务 Key 的池化管理（带权重轮询、失败自动冷却）
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            loading={loading && configs.length > 0}
            onClick={() => void Promise.all([loadConfigs(), loadBalances()])}
          >
              {!loading || configs.length === 0 ? <RotateCcw size={14} /> : null}
            刷新
          </Button>
          <Button
            variant="outline"
            size="sm"
            loading={loadingBalances}
            onClick={() => void loadBalances()}
          >
            查询余额
          </Button>
          <label className="inline-flex items-center">
            <input
              type="file"
              accept=".txt,text/plain"
              className="hidden"
              disabled={importing}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void handleImportFile(file);
              }}
            />
            <span className="btn-outline px-3 py-1.5 rounded-lg text-xs cursor-pointer">
              {importing ? '导入中…' : '导入项目key.txt'}
            </span>
          </label>
          <Button
            variant={showAddForm ? "subtle" : "primary"}
            size="sm"
            onClick={() => {
              if (showAddForm) {
                resetAddForm();
                setShowAddForm(false);
              } else {
                setShowAddForm(true);
              }
            }}
          >
            {showAddForm ? <X size={14} /> : <Plus size={14} />}
            {showAddForm ? "收起" : "添加 Key"}
          </Button>
        </div>
      </div>
      <p className="mb-4 text-[11px] text-[var(--text-3)]">
        浏览器安全限制无法自动读取桌面文件；请选择项目key.txt。仅识别 Kimi、DeepSeek、ARK，重复 Key 自动跳过。
      </p>

      {/* 添加表单（折叠） */}
      {showAddForm && (
        <div className="mb-5 p-4 rounded-xl border border-[var(--border-light)] bg-[var(--bg-2)] space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col">
              <label className="block text-[10px] font-semibold text-[var(--text-3)] mb-1.5 uppercase tracking-wider">
                服务商 <span className="text-[var(--error)]">*</span>
              </label>
              <div className="relative">
                <select
                  value={addProvider}
                  onChange={(e) => setAddProvider(e.target.value)}
                  className="input-base w-full px-3 py-2 pr-8 rounded-lg text-xs appearance-none cursor-pointer"
                  aria-label="服务商"
                >
                  {PROVIDER_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {getProviderMeta(key).name}（{key}）
                    </option>
                  ))}
                </select>
                <svg
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-3)]"
                  width="10"
                  height="10"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M4 6l4 4 4-4"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <span className="mt-1 text-[10px] text-[var(--text-3)]">
                仅网关已接入的 {PROVIDER_KEYS.length} 家 provider 可真实调用。
              </span>
            </div>
            <div className="flex flex-col">
              <label className="block text-[10px] font-semibold text-[var(--text-3)] mb-1.5 uppercase tracking-wider">
                标签
              </label>
              <Input
                value={addLabel}
                onChange={(e) => setAddLabel(e.target.value)}
                placeholder="如：主号、备用"
              />
            </div>
          </div>
          <div className="flex flex-col">
            <label className="block text-[10px] font-semibold text-[var(--text-3)] mb-1.5 uppercase tracking-wider">
              API Key <span className="text-[var(--error)]">*</span>
            </label>
            <Input
              type="password"
              value={addApiKey}
              onChange={(e) => setAddApiKey(e.target.value)}
              placeholder="sk-..."
              className="font-mono"
              autoComplete="new-password"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col">
              <label className="block text-[10px] font-semibold text-[var(--text-3)] mb-1.5 uppercase tracking-wider">
                权重
              </label>
              <Input
                type="number"
                min={1}
                step={1}
                value={addWeight}
                onChange={(e) => setAddWeight(Math.max(1, Number(e.target.value) || 1))}
                className="tabular-nums"
              />
              <p className="mt-1 text-[10px] text-[var(--text-3)]">
                同服务商多 Key 时，按权重加权轮询
              </p>
            </div>
            <div className="flex flex-col">
              <label className="block text-[10px] font-semibold text-[var(--text-3)] mb-1.5 uppercase tracking-wider">
                并发上限
              </label>
              <Input
                type="number"
                min={1}
                step={1}
                value={addMaxConcurrent}
                onChange={(e) => setAddMaxConcurrent(e.target.value)}
                placeholder="留空=不限"
                className="tabular-nums"
              />
              <p className="mt-1 text-[10px] text-[var(--text-3)]">
                ark 视频建议 3；文本类（DeepSeek/Kimi）留空不限
              </p>
            </div>
          </div>
          <div className="flex flex-col">
            <label className="block text-[10px] font-semibold text-[var(--text-3)] mb-1.5 uppercase tracking-wider">
              Base URL（可选）
            </label>
            <Input
              value={addBaseUrl}
              onChange={(e) => setAddBaseUrl(e.target.value)}
              placeholder="留空使用官方默认地址"
              className="font-mono"
            />
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                resetAddForm();
                setShowAddForm(false);
              }}
              disabled={adding}
            >
              取消
            </Button>
            <Button variant="primary" size="sm" loading={adding} onClick={() => void handleAdd()}>
              {!adding && <Plus size={14} />}
              添加
            </Button>
          </div>
        </div>
      )}

      {/* 列表区 */}
      {loading && configs.length === 0 ? (
        <div className="py-8 flex items-center justify-center">
          <Spinner size={20} />
        </div>
      ) : error ? (
        <div className="py-6 text-center">
          <p className="text-sm text-[var(--error)] mb-3">{error}</p>
          <Button variant="outline" size="sm" onClick={() => void loadConfigs()}>
            重新加载
          </Button>
        </div>
      ) : configs.length === 0 ? (
        <EmptyState
          icon={<KeyRound size={28} />}
          title="还没有平台 Key"
          description="点击右上角「添加 Key」开始配置"
          size="sm"
        />
      ) : (
        <div className="space-y-5">
          {groups.map(([provider, list]) => {
            const meta = getProviderMeta(provider);
            // 聚合并发容量：仅统计设了 maxConcurrent 的 key；全 null=不限（不显示容量）
            const caps = list
              .map((c) => c.maxConcurrent)
              .filter((n): n is number => n != null);
            const totalConcurrent = caps.reduce((a, b) => a + b, 0);
            const hasCap = caps.length > 0;
            return (
            <div key={provider}>
              {/* provider 分组标题：彩色字母块 + 中文名 + key + 能力徽章 + 聚合容量 */}
              <div className="flex items-center gap-2.5 mb-2.5 flex-wrap">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 font-bold text-sm"
                  style={{ backgroundColor: `${meta.color}20`, color: meta.color }}
                  aria-hidden="true"
                >
                  {meta.name.charAt(0)}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                  <span className="text-sm font-semibold text-[var(--text)]">{meta.name}</span>
                  <span className="text-[10px] text-[var(--text-3)] font-mono">{provider}</span>
                  {meta.capabilities.map((cap) => (
                    <span
                      key={cap}
                      className="px-1.5 py-0 rounded bg-[var(--accent-dim)] text-[var(--accent)] text-[9px] font-medium"
                    >
                      {PROVIDER_CAPABILITY_LABELS[cap]}
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-2 ml-auto text-[10px] text-[var(--text-3)] flex-shrink-0">
                  <span>{list.length} 把</span>
                  {hasCap && (
                    <span
                      className="text-[var(--text-2)]"
                      title="该 provider 池内已设并发上限的 key 之和"
                    >
                      聚合并发 {totalConcurrent}
                    </span>
                  )}
                </div>
              </div>
              {/* Key 行 */}
              <div className="space-y-2">
                {list.map((c) => {
                  const badge = statusBadge(c);
                  const isEditing = editingId === c.id;
                  const isTesting = testingId === c.id;
                  const isResetting = busyAction?.id === c.id && busyAction.kind === "reset";
                  const isToggling = busyAction?.id === c.id && busyAction.kind === "toggle";
                  const isBusy = busyAction?.id === c.id;
                  const tr = testResults[c.id];
                  const showReset = c.keyStatus === "invalid" || c.keyStatus === "cooldown";

                  return (
                    <div
                      key={c.id}
                      className={`p-3 rounded-lg border transition-colors ${
                        isEditing
                          ? "bg-[var(--action-dim)] border-[var(--action)]/30"
                          : "bg-[var(--bg-2)] border-[var(--border-light)]"
                      }`}
                    >
                      {/* 行主体 */}
                      <div className="flex items-center gap-2 flex-wrap">
                        {/* 标签 */}
                        {c.label && (
                          <span className="text-xs font-medium text-[var(--text-2)] px-1.5 py-0.5 rounded bg-[var(--accent-dim)]">
                            {c.label}
                          </span>
                        )}
                        {/* 默认显示掩码；管理员可按条主动查看完整 Key。 */}
                        <span className="font-mono text-xs text-[var(--text-2)]">
                          {revealedKeys[c.id] ?? c.apiKeyMasked}
                        </span>
                        {/* 状态徽章（带 tooltip） */}
                        <span className={`badge ${badge.cls} text-[10px]`} title={badge.title}>
                          {badge.text}
                        </span>
                        {/* 权重 */}
                        <span
                          className="text-[10px] text-[var(--text-3)]"
                          title="加权轮询权重"
                        >
                          权重 {c.weight}
                        </span>
                        {/* 并发上限（仅设了才显示；null=不限不在行内占位，靠分组聚合体现） */}
                        {c.maxConcurrent != null && (
                          <span
                            className="badge badge-action text-[9px] px-1.5 py-0"
                            title={`单 key 并发上限 ${c.maxConcurrent}`}
                          >
                            并发 {c.maxConcurrent}
                          </span>
                        )}
                        {/* 最后使用时间 */}
                        <span
                          className="text-[10px] text-[var(--text-3)]"
                          title={
                            c.lastUsedAt
                              ? new Date(c.lastUsedAt).toLocaleString("zh-CN", { hour12: false })
                              : "从未使用"
                          }
                        >
                          {formatRelative(c.lastUsedAt)}
                        </span>
                        {/* 余额按 Key 展示；不支持查询时给出明确文案，绝不把未知当 0。 */}
                        {balances[c.id] && (
                          <span
                            className={`text-[10px] ${balances[c.id].error ? 'text-[var(--error)]' : 'text-[var(--success)]'}`}
                            title={balances[c.id].error ?? balances[c.id].lastUpdated}
                          >
                            {balances[c.id].error
                              ? '余额查询失败'
                              : balances[c.id].balanceSupported
                                ? `余额 ${balances[c.id].balanceLabel ?? '未知'}`
                                : c.provider === 'ark'
                                  ? 'ARK 模型 Key 无费用中心余额权限'
                                  : '余额需到供应商后台查看'}
                          </span>
                        )}
                        {/* 错误计数 */}
                        {c.errorCount > 0 && (
                          <span
                            className={`text-[10px] ${
                              c.keyStatus === "invalid"
                                ? "text-[var(--error)]"
                                : "text-[var(--text-3)]"
                            }`}
                            title={c.lastErrorMessage ?? `累计错误 ${c.errorCount} 次`}
                          >
                            错误 {c.errorCount}
                            {c.consecutiveFailures > 0
                              ? ` / 连续 ${c.consecutiveFailures}`
                              : ""}
                          </span>
                        )}
                        {/* 操作按钮 */}
                        <div className="ml-auto flex items-center gap-1 flex-shrink-0">
                          {/* 明文只按条读取，并可立即隐藏。 */}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleReveal(c)}
                            loading={revealingId === c.id}
                            className="h-auto inline-flex items-center text-xs text-[var(--text-3)] hover:text-[var(--action)] px-1.5 py-0.5 rounded transition-colors"
                            title={revealedKeys[c.id] ? '隐藏完整 Key' : '查看完整 Key'}
                          >
                            {revealedKeys[c.id] ? (
                              <EyeOff size={12} className="inline-block align-middle" />
                            ) : (
                              <Eye size={12} className="inline-block align-middle" />
                            )}
                            <span className="ml-1 align-middle">
                              {revealedKeys[c.id] ? '隐藏' : '查看'}
                            </span>
                          </Button>
                          {/* 测试连通 */}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleTest(c)}
                            loading={isTesting}
                            className={`h-auto inline-flex items-center text-xs px-1.5 py-0.5 rounded transition-colors ${
                              isTesting
                                ? "text-[var(--text-3)] cursor-not-allowed"
                                : "text-[var(--action)] hover:text-[var(--action-hover)]"
                            }`}
                            title="测试连通"
                          >
                            <Zap size={12} className="inline-block align-middle" />
                            <span className="ml-1 align-middle">
                              {isTesting ? "测试中" : "测试"}
                            </span>
                          </Button>
                          {/* 重置状态（仅异常态显示） */}
                          {showReset && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => void handleResetStatus(c)}
                              loading={isResetting}
                              disabled={isBusy || busyAction !== null}
                              className="h-auto inline-flex items-center text-xs text-[var(--text-3)] hover:text-[var(--success)] px-1.5 py-0.5 rounded transition-colors"
                              title="重置为可用"
                            >
                              <RotateCcw size={12} className="inline-block align-middle" />
                              <span className="ml-1 align-middle">重置</span>
                            </Button>
                          )}
                          {/* 启用 / 禁用 */}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleToggleEnabled(c)}
                            loading={isToggling}
                            disabled={isBusy || busyAction !== null}
                            className={`h-auto inline-flex items-center text-xs px-1.5 py-0.5 rounded transition-colors ${
                              c.isEnabled
                                ? "text-[var(--text-3)] hover:text-[var(--warning)]"
                                : "text-[var(--success)] hover:brightness-110"
                            }`}
                            title={c.isEnabled ? "禁用此 Key" : "启用此 Key"}
                          >
                            <Power size={12} className="inline-block align-middle" />
                            <span className="ml-1 align-middle">
                              {c.isEnabled ? "禁用" : "启用"}
                            </span>
                          </Button>
                          {/* 编辑 */}
                          <button
                            type="button"
                            onClick={() => (isEditing ? cancelEdit() : startEdit(c))}
                            className="inline-flex items-center text-xs text-[var(--text-3)] hover:text-[var(--action)] px-1.5 py-0.5 rounded transition-colors"
                            title="编辑"
                          >
                            <Pencil size={12} className="inline-block align-middle" />
                            <span className="ml-1 align-middle">
                              {isEditing ? "取消" : "编辑"}
                            </span>
                          </button>
                          {/* 删除 */}
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(c)}
                            className="inline-flex items-center text-xs text-[var(--text-3)] hover:text-[var(--error)] px-1.5 py-0.5 rounded transition-colors"
                            title="删除"
                          >
                            <Trash2 size={12} className="inline-block align-middle" />
                            <span className="ml-1 align-middle">删除</span>
                          </button>
                        </div>
                      </div>

                      {/* BaseUrl 展示 */}
                      {c.baseUrl && !isEditing && (
                        <div className="mt-1.5 text-[10px] text-[var(--text-3)]">
                          BaseUrl: <span className="font-mono">{c.baseUrl}</span>
                        </div>
                      )}

                      {/* 测试结果 */}
                      {tr && !isEditing && (
                        <div
                          className={`mt-2 p-2 rounded text-[11px] ${
                            tr.ok
                              ? "bg-[var(--success-dim)] text-[var(--success)]"
                              : "bg-[var(--error-dim)] text-[var(--error)]"
                          }`}
                        >
                          <span aria-hidden="true">{tr.ok ? "✓" : "✗"}</span> {tr.message}
                        </div>
                      )}

                      {/* 内联编辑表单 */}
                      {isEditing && (
                        <div className="mt-3 pt-3 border-t border-[var(--border-light)] space-y-3">
                          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                            <div className="flex flex-col">
                              <label className="block text-[10px] font-semibold text-[var(--text-3)] mb-1.5 uppercase tracking-wider">
                                标签
                              </label>
                              <Input
                                value={editLabel}
                                onChange={(e) => setEditLabel(e.target.value)}
                                placeholder="（可选）"
                              />
                            </div>
                            <div className="flex flex-col">
                              <label className="block text-[10px] font-semibold text-[var(--text-3)] mb-1.5 uppercase tracking-wider">
                                权重
                              </label>
                              <Input
                                type="number"
                                min={1}
                                step={1}
                                value={editWeight}
                                onChange={(e) =>
                                  setEditWeight(Math.max(1, Number(e.target.value) || 1))
                                }
                                className="tabular-nums"
                              />
                            </div>
                            <div className="flex flex-col">
                              <label className="block text-[10px] font-semibold text-[var(--text-3)] mb-1.5 uppercase tracking-wider">
                                并发上限
                              </label>
                              <Input
                                type="number"
                                min={1}
                                step={1}
                                value={editMaxConcurrent}
                                onChange={(e) => setEditMaxConcurrent(e.target.value)}
                                placeholder="留空=不限"
                                className="tabular-nums"
                              />
                            </div>
                            <div className="flex flex-col">
                              <label className="block text-[10px] font-semibold text-[var(--text-3)] mb-1.5 uppercase tracking-wider">
                                启用
                              </label>
                              <button
                                type="button"
                                onClick={() => setEditIsEnabled((v) => !v)}
                                className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 self-start mt-1 ${
                                  editIsEnabled ? "bg-[var(--action)]" : "bg-[var(--border)]"
                                }`}
                                aria-label={editIsEnabled ? "切到禁用" : "切到启用"}
                                aria-pressed={editIsEnabled}
                              >
                                <span
                                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                                    editIsEnabled ? "translate-x-5" : ""
                                  }`}
                                />
                              </button>
                            </div>
                          </div>
                          <div className="flex flex-col">
                            <label className="block text-[10px] font-semibold text-[var(--text-3)] mb-1.5 uppercase tracking-wider">
                              替换 API Key（可选）
                            </label>
                            <Input
                              type="password"
                              value={editApiKey}
                              onChange={(e) => setEditApiKey(e.target.value)}
                              placeholder="留空保留当前 Key"
                              className="font-mono"
                              autoComplete="new-password"
                            />
                            <p className="mt-1 text-[10px] text-[var(--text-3)]">
                              替换后会清除旧 Key 的失效/冷却状态，并立即允许重新测试。
                            </p>
                          </div>
                          <div className="flex flex-col">
                            <label className="block text-[10px] font-semibold text-[var(--text-3)] mb-1.5 uppercase tracking-wider">
                              Base URL
                            </label>
                            <Input
                              value={editBaseUrl}
                              onChange={(e) => setEditBaseUrl(e.target.value)}
                              placeholder="留空使用官方默认地址"
                              className="font-mono"
                            />
                          </div>
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={cancelEdit}
                              disabled={savingEdit}
                            >
                              取消
                            </Button>
                            <Button
                              variant="primary"
                              size="sm"
                              loading={savingEdit}
                              onClick={() => void handleSaveEdit(c)}
                            >
                              保存
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            );
          })}
        </div>
      )}

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除此 Key？"
        message={
          deleteTarget
            ? `将永久删除 ${deleteTarget.provider}${
                deleteTarget.label ? `（${deleteTarget.label}）` : ""
              } 的此 Key，操作不可恢复。`
            : ""
        }
        variant="danger"
        confirmLabel="删除"
        cancelLabel="取消"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        loading={deleting}
      />
    </section>
  );
}
