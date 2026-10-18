"use client";

/**
 * @file settings/page.tsx — 设置页（批1 富化 + app1 对齐补全）
 *
 * dramaforge C/S 约束：
 *   - GC-1：AI key 云端管理（无 BYOK）。app1 的 ProviderCard / SECTIONS /
 *     ConfigItem / INPUT_LABELS / AI 模型 API 配置板块 / ProviderBalancePanel /
 *     api-configs / api-config test route 等 BYOK 相关区块全部不做。
 *   - dramaforge-assets-client-local：媒体资产只存客户端本地硬盘。
 *
 * 卡片（自上而下，对齐 app1 视觉：card-pad / mb-6 sm:mb-8 / 11x11 rounded-2xl 图标容器）：
 *   1. 修改密码（照搬 app1 lines 331-348；LockIcon + --action 蓝 + 弹 ChangePasswordModal）
 *   2. 退出登录（照搬 app1 lines 350-369；LogOut + --error 红 + danger 按钮）
 *   3. 客户端连接（dramaforge C/S 特色，app1 无；含 IPC sf:check-for-update 检查更新按钮）
 *   4. 稀疏网格（照搬 app1 lines 1482-1685；人物参考图叠加网格绕过 Seedance 真人检测）
 *   5. 彩铅风格（照搬 app1 lines 1358-1480；资产级彩铅开关总闸）
 *   6. API Key 池（admin-only，替代原「关于」卡；非 admin 不渲染）
 *
 * 顶部用 AppHeader（与 workspace/page.tsx 一致）：左=返回+设置，右=CreditsBadge(lg)
 * 覆盖"充值相关"——CreditsBadge 内部走 RechargeProvider 拉起 PlatformRechargeModal。
 *
 * AppHeader 与 main 之间挂 RedisStatusIndicator（2026-07-21 补）：
 *   - 组件本身 1:1 镜像 app1（components/features/RedisStatus.tsx），视觉/交互零改。
 *   - app1 中挂在 workspace 页顶部（header → GlobalGenerationStatus → RedisStatusIndicator
 *     → main）；dramaforge 决策改为挂在 /settings 页，因 settings 已是运维向状态卡集合
 *     （ClientConnectionCard 等），RedisStatus 同属运维指标放此处更契合。挂载点变了，
 *     组件一行未改。
 *   - 后端走 /api/system/redis-status（对齐 app1，三模式 default/quick/stream；
 *     dramaforge 复用 @server/infra getRedis() 单例，无鉴权与 app1 一致）。
 *
 * 不做（除 GC-1 BYOK 外的 app1 区块）：
 *   - 用户数据导出（app1 457-588）：dramaforge 无 /api/system/users/export 路由
 *   - 网络代理（app1 1118-1356）：dramaforge C/S 由云端服务器访问 AI 服务，客户端无需代理
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import { ArrowLeft, Lock as LockIcon, LogOut, MonitorSmartphone, RefreshCw, Wifi } from "lucide-react";
import { Spinner } from "../../components/ui/Spinner";
import { Button } from "../../components/ui/Button";
import { ChangePasswordModal } from "../../components/ui/ChangePasswordModal";
import { CreditsBadge } from "../../components/ui/CreditsBadge";
import { useToast } from "../../components/ui/Toast";
import { AppHeader } from "../../components/layout/AppHeader";
import { RedisStatusIndicator } from "../../components/features/RedisStatus";
import { ApiKeyPoolCard } from "../../components/features/ApiKeyPoolCard";

// window.sfShell 类型由 types/sf-shell.d.ts 全局声明（与 client preload 对齐），
// 不再本地重复定义 SfShellBridge，也不再写 `as Window & { sfShell?: ... }`。

type ClientStatus =
  | { kind: "loading" }
  | { kind: "browser" }
  | { kind: "electron"; version: string };

/**
 * 客户端连接状态卡（dramaforge C/S 特色，app1 无）
 *
 * SSR 阶段保持 "loading" 渲染避免 hydration mismatch；mount 后 useEffect
 * 读 window.sfShell.isElectron + getAppVersion 切到实际状态。
 *
 * getAppVersion 经 ipcRenderer.invoke 异步返回 Promise（见 preload.ts），
 * 不能同步调用——之前同步读导致 "版本 v[object Promise]"。
 * useEffect 内 await 取值再 setState，并带 alive flag 防卸载后覆盖。
 *
 * Electron 态额外渲染"检查更新"按钮（手动入口，叠加于后台静默轮询之上）：
 *   - 点击 → checkForUpdate IPC → toast 反馈（已是最新 / 发现新版 / 网络错误）。
 *   - 发现新版时 main 进程会同时弹"重启以安装"系统对话框（与自动轮询共用
 *     promptAndInstall），renderer 只需提示用户去看弹窗。
 *   - 复用现有 Button + useToast，不自造组件（硬约束：UI 照搬 app1 卡片样式）。
 */
function ClientConnectionCard() {
  const toast = useToast();
  const [status, setStatus] = React.useState<ClientStatus>({ kind: "loading" });
  const [checking, setChecking] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    const shell = typeof window !== "undefined" ? window.sfShell : undefined;
    if (shell?.isElectron === true) {
      // getAppVersion 在 d.ts 里是 `() => Promise<string>`；可选链兜底防 preload 不完整。
      const versionP = Promise.resolve(shell.getAppVersion?.()).catch(() => undefined);
      void versionP.then((v) => {
        if (!alive) return;
        setStatus({
          kind: "electron",
          version: typeof v === "string" && v ? v : "未知版本",
        });
      });
    } else {
      setStatus({ kind: "browser" });
    }
    return () => {
      alive = false;
    };
  }, []);

  /** 手动检查更新：调 IPC → 据 ManualCheckResult toast。 */
  const handleCheckUpdate = React.useCallback(async () => {
    const shell = typeof window !== "undefined" ? window.sfShell : undefined;
    if (!shell?.isElectron || !shell.checkForUpdate) return;
    setChecking(true);
    try {
      const result = await shell.checkForUpdate();
      if (result.outcome === "no-update") {
        toast.success(`已是最新版本（v${result.latestVersion}）`);
      } else if (result.outcome === "update-available") {
        // main 进程已弹"重启以安装"系统对话框，这里只补一条 toast 提示。
        toast.info(
          result.downloaded
            ? `发现新版本 v${result.latestVersion}，下载完成，请按提示重启安装`
            : `发现新版本 v${result.latestVersion}，请按提示重启安装`,
        );
      } else {
        toast.error(`检查更新失败：${result.message}`);
      }
    } catch (err) {
      // IPC 永不 reject（main 侧 catch-all），兜底以防 preload 不完整等极端情况。
      toast.error(`检查更新失败：${String(err)}`);
    } finally {
      setChecking(false);
    }
  }, [toast]);

  return (
    <section className="card card-pad mb-6 sm:mb-8">
      <h2 className="text-sm font-semibold text-[var(--text-2)] uppercase tracking-wider mb-3">
        客户端连接
      </h2>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
              status.kind === "electron"
                ? "bg-[var(--success-dim)] text-[var(--success)]"
                : status.kind === "browser"
                  ? "bg-[var(--text-3)]/15 text-[var(--text-3)]"
                  : "bg-[var(--accent-dim)] text-[var(--accent)]"
            }`}
          >
            {status.kind === "electron" ? <Wifi size={20} /> : <MonitorSmartphone size={20} />}
          </div>
          <div className="min-w-0">
            {status.kind === "loading" && (
              <>
                <p className="text-sm font-medium text-[var(--text)]">检测中…</p>
                <p className="text-xs text-[var(--text-3)]">正在读取客户端信息</p>
              </>
            )}
            {status.kind === "electron" && (
              <>
                <p className="text-sm font-medium text-[var(--text)]">已连接桌面客户端</p>
                <p className="text-xs text-[var(--text-3)] tabular-nums">
                  版本 v{status.version}
                </p>
              </>
            )}
            {status.kind === "browser" && (
              <>
                <p className="text-sm font-medium text-[var(--text)]">浏览器环境</p>
                <p className="text-xs text-[var(--text-3)]">
                  媒体资产保存等功能请在 DramaForge 桌面客户端中打开使用
                </p>
              </>
            )}
          </div>
        </div>
        {status.kind === "electron" && (
          <Button
            variant="outline"
            size="sm"
            loading={checking}
            onClick={() => void handleCheckUpdate()}
          >
            {!checking && <RefreshCw size={14} />}
            {checking ? "正在检查…" : "检查更新"}
          </Button>
        )}
      </div>
    </section>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [changePasswordOpen, setChangePasswordOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);

  const handleSignOut = React.useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut({ callbackUrl: "/auth/signin", redirect: true });
    } finally {
      setSigningOut(false);
    }
  }, [signingOut]);

  if (status === "loading") {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <Spinner size={28} />
      </main>
    );
  }

  if (status === "unauthenticated") {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-4 px-4">
        <p className="text-sm text-[var(--text-3)]">未登录，请先登录</p>
        <Link href="/auth/signin" className="text-[var(--action)] hover:underline">
          去登录
        </Link>
      </main>
    );
  }

  return (
    <div className="flex-1 bg-[var(--bg)] flex flex-col overflow-hidden">
      {/* 顶部导航栏：返回按钮 + 标题 + 积分徽标（对齐 workspace 页） */}
      <AppHeader
        left={
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                // 优先返回来源页（如项目编辑器）；无历史记录时兜底到工作区
                if (typeof window !== "undefined" && window.history.length > 1) {
                  router.back();
                } else {
                  router.push("/workspace");
                }
              }}
              className="text-sm text-[var(--text-3)] hover:text-[var(--text)] transition-colors flex items-center gap-2"
              aria-label="返回"
            >
              <ArrowLeft size={20} />
              <span className="hidden sm:inline">返回</span>
            </button>
            <div className="w-px h-5 bg-[var(--border)]" aria-hidden="true" />
            <span className="font-bold text-[var(--text)]">设置</span>
          </div>
        }
        right={<CreditsBadge size="lg" />}
      />

      {/*
        Redis 服务状态指示器（2026-07-21 补；对齐 app1 workspace 顶部布局）。
        组件 1:1 镜像 app1，挂载点改为 settings（与 ClientConnectionCard 等
        运维向卡同页）。loading/无数据时不渲染任何 DOM，未登录/SSR 阶段透明。
      */}
      <RedisStatusIndicator />

      {/* 主内容区域 */}
      <main className="flex-1 overflow-auto section-y">
        <div className="container-app max-w-4xl">
          {/* 页面说明 */}
          <div className="mb-6 sm:mb-8">
            <h1
              className="text-display font-bold text-[var(--text)] mb-2"
              style={{ fontFamily: "var(--font-display)" }}
            >
              设置
            </h1>
            <p className="text-sm text-[var(--text-2)] leading-relaxed">
              在这里管理账户、安全、客户端连接与生成参数。
              <br />
              <span className="text-[var(--text-3)]">
                AI 模型 Key 由平台云端统一管理，无需在此配置；每次执行业务流程后，系统会按实际消耗的 token 自动扣除积分。
              </span>
            </p>
          </div>

          {/* 账户安全：修改密码（照搬 app1 331-348，--action 蓝容器） */}
          <div className="card card-pad mb-6 sm:mb-8">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-2xl bg-[var(--action-dim)] flex items-center justify-center flex-shrink-0">
                  <LockIcon size={22} className="text-[var(--action)]" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-[var(--text)]">修改密码</h2>
                  <p className="text-xs text-[var(--text-3)]">建议定期修改密码，保障账号安全</p>
                </div>
              </div>
              <Button variant="outline" size="md" onClick={() => setChangePasswordOpen(true)}>
                修改密码
              </Button>
            </div>
          </div>

          {/* 退出登录（照搬 app1 350-369，--error 红容器 + danger 按钮） */}
          <div className="card card-pad mb-6 sm:mb-8">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-2xl bg-[var(--error)]/10 flex items-center justify-center flex-shrink-0">
                  <LogOut size={22} className="text-[var(--error)]" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg font-bold text-[var(--text)]">退出登录</h2>
                  <p className="text-xs text-[var(--text-3)] truncate">
                    当前账号：{session?.user?.email || session?.user?.name || "已登录"}
                  </p>
                </div>
              </div>
              <Button
                variant="danger"
                size="md"
                onClick={() => void handleSignOut()}
                loading={signingOut}
              >
                {signingOut ? "退出中…" : "退出登录"}
              </Button>
            </div>
          </div>

          {/* 客户端连接（dramaforge C/S 特色，app1 无；保留含检查更新按钮） */}
          <ClientConnectionCard />

          {/* 深度图推理环境（参考视频转绘用；云端版按需下载） */}
          <DepthEnvCard />

          {/* 稀疏网格（照搬 app1 1482-1685；人物参考图叠加网格绕过 Seedance 真人检测） */}
          <GridCard />

          {/* 彩铅风格（照搬 app1 1358-1480；资产级彩铅开关总闸） */}
          <PencilCard />

          {/*
            API Key 池（admin-only）：替代原「关于 / 平台约束」卡。
            组件内 useSession 自门 admin（session.user.role === 'ADMIN'），
            非 admin 渲染 null —— 普通用户进入 settings 页看不到此区块。
          */}
          <ApiKeyPoolCard />
        </div>
      </main>

      {/* 修改密码弹窗：前后端共用“至少 8 位且包含字母和数字”的策略。 */}
      <ChangePasswordModal
        open={changePasswordOpen}
        onClose={() => setChangePasswordOpen(false)}
      />
    </div>
  );
}

// ============================================================
// 深度图推理环境卡片（支持手动选择本地环境）
// ============================================================

function DepthEnvCard() {
  const toast = useToast();
  const [envStatus, setEnvStatus] = React.useState<{
    python: boolean;
    model: boolean;
    pythonPath: string;
    modelsPath: string;
    ready: boolean;
  } | null>(null);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const checkEnv = React.useCallback(async () => {
    const shell = typeof window !== "undefined" ? window.sfShell : undefined;
    if (!shell?.isElectron || !shell.checkDepthEnv) {
      setEnvStatus(null);
      return;
    }
    try {
      const res = await shell.checkDepthEnv();
      setEnvStatus({
        python: res.python,
        model: res.model,
        pythonPath: res.pythonPath || "",
        modelsPath: (res as { modelsPath?: string }).modelsPath || "",
        ready: res.ready,
      });
    } catch {
      setEnvStatus(null);
    }
  }, []);

  React.useEffect(() => {
    if (mounted) void checkEnv();
  }, [mounted, checkEnv]);

  const handleSelectPython = React.useCallback(async () => {
    const shell = typeof window !== "undefined" ? window.sfShell : undefined;
    if (!shell?.selectDepthPython) return;
    try {
      const res = await shell.selectDepthPython();
      if (res.ok) toast.success("Python 环境已选择");
      void checkEnv();
    } catch {
      /* cancelled */
    }
  }, [toast, checkEnv]);

  const handleSelectModels = React.useCallback(async () => {
    const shell = typeof window !== "undefined" ? window.sfShell : undefined;
    if (!shell?.selectDepthModels) return;
    try {
      const res = await shell.selectDepthModels();
      if (res.ok) toast.success("模型目录已选择");
      void checkEnv();
    } catch {
      /* cancelled */
    }
  }, [toast, checkEnv]);

  const handleDownload = React.useCallback(async () => {
    const shell = typeof window !== "undefined" ? window.sfShell : undefined;
    if (!shell?.downloadDepthEnv) return;
    try {
      const res = await shell.downloadDepthEnv();
      if (res.ok) { toast.success("推理环境安装完成"); }
      else { toast.error("下载失败: " + (res.error ?? "未知错误")); }
    } catch (err) {
      toast.error("下载失败");
    }
    void checkEnv();
  }, [toast, checkEnv]);

  if (!mounted) return null;
  const shell = typeof window !== "undefined" ? window.sfShell : undefined;
  if (!shell?.isElectron) return null;
  const canSelect = !!shell.selectDepthPython && !!shell.selectDepthModels;

  return (
    <div className="card-pad rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-2)] mb-6 sm:mb-8">
      <div className="flex items-start gap-4 mb-4">
        <div className="w-11 h-11 rounded-2xl bg-[var(--bg-3)] flex items-center justify-center shrink-0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-lg font-bold text-[var(--text)]">深度图推理环境</h2>
            {envStatus?.ready && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/15 text-green-600">就绪</span>
            )}
          </div>
          <p className="text-xs text-[var(--text-3)] leading-relaxed">
            参考视频转绘所需的 Depth Anything V2 Large 推理环境。
          </p>
        </div>
      </div>
      {/* Python 环境 */}
      <div className="flex items-center justify-between gap-3 py-3 border-t border-[var(--border)]">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--text)]">Python 推理环境</span>
            {envStatus?.python ? (
              <span className="text-xs text-green-600">✓</span>
            ) : (
              <span className="text-xs text-[var(--text-3)]">未配置</span>
            )}
          </div>
          {envStatus?.pythonPath ? (
            <p className="text-xs text-[var(--text-3)] truncate mt-0.5">{envStatus.pythonPath}</p>
          ) : (
            <p className="text-xs text-[var(--text-3)] mt-0.5">选择 python-env 目录里的 python.exe</p>
          )}
        </div>
        {canSelect && (
          <Button size="sm" variant="ghost" onClick={() => void handleSelectPython()}>
            选择…
          </Button>
        )}
      </div>
      {/* 模型目录 */}
      <div className="flex items-center justify-between gap-3 py-3 border-t border-[var(--border)]">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--text)]">深度模型目录</span>
            {envStatus?.model ? (
              <span className="text-xs text-green-600">✓</span>
            ) : (
              <span className="text-xs text-[var(--text-3)]">未配置</span>
            )}
          </div>
          {envStatus?.modelsPath ? (
            <p className="text-xs text-[var(--text-3)] truncate mt-0.5">{envStatus.modelsPath}</p>
          ) : (
            <p className="text-xs text-[var(--text-3)] mt-0.5">选择 depth-models 目录</p>
          )}
        </div>
        {canSelect && (
          <Button size="sm" variant="ghost" onClick={() => void handleSelectModels()}>
            选择…
          </Button>
        )}
      </div>
      {/* 未就绪时的下载链接 */}
      {envStatus && !envStatus.ready && (
        <div className="mt-3 pt-3 border-t border-[var(--border)]">
          <p className="text-xs text-[var(--text-3)] mb-2">
            手动下载解压后用上方按钮选择：
          </p>
          <div className="space-y-1">
            <a href="https://your-domain.example.com/downloads/python-env.tar.gz" target="_blank" rel="noopener" className="block text-xs text-[var(--action)] hover:underline">→ python-env.tar.gz（2.4GB）</a>
            <a href="https://your-domain.example.com/downloads/depth-models.tar.gz" target="_blank" rel="noopener" className="block text-xs text-[var(--action)] hover:underline">→ depth-models.tar.gz（1.2GB）</a>
          </div>
        </div>
      )}
    </div>
  );
}


// 稀疏网格配置卡片（照搬 app1 lines 1482-1685；纯前端 localStorage）
// ============================================================

/**
 * 稀疏网格配置卡片
 *
 * 全局共享配置（非用户级），用于对人物参考图叠加白色 3D 几何拓扑线框网格，
 * 绕过 Seedance 2.0 真人检测机制。
 *
 * 存储模式：纯前端 localStorage（全局键），与项目页 page.tsx 的读取逻辑对齐。
 * 修改后自动保存，项目页通过 window focus 事件重读 localStorage 实现跨页同步。
 *
 * 功能：
 * - 启用/关闭网格开关（默认 ON）
 * - 三个滑块：网格密度 cells、线条不透明度 opacity、线条宽度 strokeWidth
 * - 禁用时滑块区域灰显
 * - 恢复默认参数按钮
 */
function GridCard() {
  const toast = useToast();
  // SSR/CSR 首次渲染必须用相同的固定默认值，避免 hydration mismatch
  // （localStorage 在服务端不可用，lazy initializer 会导致服务端/客户端渲染不一致）
  /** 是否启用稀疏网格（默认 true：有人物参考图时叠加网格绕过真人检测） */
  const [enabled, setEnabled] = React.useState<boolean>(true);
  /** 网格密度（格数，20-400，默认 100；对齐 app1 + route 校验上限 400） */
  const [cells, setCells] = React.useState<number>(100);
  /** 线条不透明度（0.1-1，默认 0.6） */
  const [opacity, setOpacity] = React.useState<number>(0.6);
  /** 线条宽度（0.5-3px，默认 1） */
  const [strokeWidth, setStrokeWidth] = React.useState<number>(1);
  /** 客户端是否已完成 localStorage 恢复（避免持久化默认值覆盖用户设置） */
  const [hydrated, setHydrated] = React.useState(false);

  // 客户端 mount 后读取 localStorage 恢复用户设置
  React.useEffect(() => {
    try {
      if (localStorage.getItem("gridEnabled") === "false") setEnabled(false);
      const c = Number(localStorage.getItem("gridCells"));
      if (c) setCells(c);
      const o = Number(localStorage.getItem("gridOpacity"));
      if (o) setOpacity(o);
      const sw = Number(localStorage.getItem("gridStrokeWidth"));
      if (sw) setStrokeWidth(sw);
    } catch {}
    setHydrated(true);
  }, []);

  // 自动持久化到全局 localStorage（仅在 hydrated 后执行，避免默认值覆盖 localStorage 用户值）
  React.useEffect(() => {
    if (hydrated) {
      try {
        localStorage.setItem("gridEnabled", String(enabled));
      } catch {}
    }
  }, [enabled, hydrated]);
  React.useEffect(() => {
    if (hydrated) {
      try {
        localStorage.setItem("gridCells", String(cells));
      } catch {}
    }
  }, [cells, hydrated]);
  React.useEffect(() => {
    if (hydrated) {
      try {
        localStorage.setItem("gridOpacity", String(opacity));
      } catch {}
    }
  }, [opacity, hydrated]);
  React.useEffect(() => {
    if (hydrated) {
      try {
        localStorage.setItem("gridStrokeWidth", String(strokeWidth));
      } catch {}
    }
  }, [strokeWidth, hydrated]);

  /** 恢复默认参数 */
  const handleReset = () => {
    setEnabled(true);
    setCells(100);
    setOpacity(0.6);
    setStrokeWidth(1);
    toast.success("已恢复稀疏网格默认参数");
  };

  return (
    <div className="mb-6 sm:mb-8">
      {/* 板块标题 */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-11 h-11 rounded-2xl bg-[var(--accent-dim)] flex items-center justify-center">
          {/* 网格图标 */}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="3" width="18" height="18" rx="1" stroke="var(--accent)" strokeWidth="2" />
            <path
              d="M3 9h18M3 15h18M9 3v18M15 3v18"
              stroke="var(--accent)"
              strokeWidth="2"
            />
          </svg>
        </div>
        <div>
          <h2 className="text-lg font-bold text-[var(--text)]">稀疏网格</h2>
          <p className="text-xs text-[var(--text-3)]">
            为人物参考图叠加稀疏网格，用于规避 Seedance 2.0 的真人检测
          </p>
        </div>
      </div>

      {/* 卡片主体 */}
      <div className="card p-5">
        {/* 顶部：启用开关 + 状态 */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            {/* 启用开关 */}
            <button
              onClick={() => setEnabled((e) => !e)}
              className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
                enabled ? "bg-[var(--action)]" : "bg-[var(--border)]"
              } cursor-pointer`}
              aria-label={enabled ? "关闭稀疏网格" : "开启稀疏网格"}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                  enabled ? "translate-x-5" : ""
                }`}
              />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[var(--text)]">
                  {enabled ? "稀疏网格已开启" : "稀疏网格已关闭"}
                </span>
                <span className={`badge ${enabled ? "badge-success" : "badge-muted"}`}>
                  {enabled ? "ON" : "OFF"}
                </span>
              </div>
              <p className="text-xs text-[var(--text-3)] mt-0.5">
                {enabled
                  ? `当前参数：${cells} 格 / 不透明度 ${opacity.toFixed(2)} / 线条宽度 ${strokeWidth.toFixed(1)}px`
                  : "关闭后参考图将按原图提交，可能触发真人检测。"}
              </p>
            </div>
          </div>
        </div>

        {/* 三个滑块（禁用时灰显） */}
        <div
          className={`space-y-4 transition-opacity ${
            enabled ? "" : "opacity-50 pointer-events-none"
          }`}
        >
          {/* 网格密度 */}
          <div>
            <div className="flex justify-between items-center mb-1.5">
              <label className="text-xs font-semibold text-[var(--text-2)] uppercase tracking-wider">
                网格密度
              </label>
              <span className="text-xs font-mono text-[var(--accent)]">{cells} 格</span>
            </div>
            <input
              type="range"
              min={20}
              max={400}
              step={10}
              value={cells}
              onChange={(e) => setCells(Number(e.target.value))}
              className="w-full accent-[var(--action)]"
              aria-label="网格密度"
            />
            <div className="flex justify-between text-[10px] text-[var(--text-3)] mt-0.5">
              <span>20（稀疏）</span>
              <span>400（密集）</span>
            </div>
          </div>

          {/* 线条不透明度 */}
          <div>
            <div className="flex justify-between items-center mb-1.5">
              <label className="text-xs font-semibold text-[var(--text-2)] uppercase tracking-wider">
                线条不透明度
              </label>
              <span className="text-xs font-mono text-[var(--accent)]">{opacity.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
              className="w-full accent-[var(--action)]"
              aria-label="线条不透明度"
            />
            <div className="flex justify-between text-[10px] text-[var(--text-3)] mt-0.5">
              <span>0.10（淡）</span>
              <span>1.00（实）</span>
            </div>
          </div>

          {/* 线条宽度 */}
          <div>
            <div className="flex justify-between items-center mb-1.5">
              <label className="text-xs font-semibold text-[var(--text-2)] uppercase tracking-wider">
                线条宽度
              </label>
              <span className="text-xs font-mono text-[var(--accent)]">
                {strokeWidth.toFixed(1)} px
              </span>
            </div>
            <input
              type="range"
              min={0.5}
              max={3}
              step={0.1}
              value={strokeWidth}
              onChange={(e) => setStrokeWidth(Number(e.target.value))}
              className="w-full accent-[var(--action)]"
              aria-label="线条宽度"
            />
            <div className="flex justify text-[10px] text-[var(--text-3)] mt-0.5">
              <span>0.5（细）</span>
              <span>3.0（粗）</span>
            </div>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center justify-between mt-4 pt-3 border-t border-[var(--border-light)]">
          <span className="text-xs text-[var(--text-3)]">配置会自动保存，返回项目后立即生效</span>
          <button onClick={handleReset} className="btn-ghost px-4 py-2 rounded-lg text-xs">
            恢复默认
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 彩铅风格能力状态（C/S 客户端协议未完成前安全停用）
// ============================================================

/**
 * app1 的真实流程需要客户端先做 I2I、持久化 pencilImageUrl，再把彩铅参考图
 * 交给视频模型还原写实。dramaforge 尚无这段客户端协议，不能用一个无消费者的
 * localStorage 开关冒充可用能力。
 */
function PencilCard() {
  return (
    <div className="mb-6 sm:mb-8">
      {/* 板块标题 */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-11 h-11 rounded-2xl bg-[var(--accent-dim)] flex items-center justify-center">
          {/* 画笔图标 */}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 19l7-7 3 3-7 7-3-3z"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M2 2l7.586 7.586"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle
              cx="11"
              cy="11"
              r="2"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div>
          <h2 className="text-lg font-bold text-[var(--text)]">彩铅风格</h2>
          <p className="text-xs text-[var(--text-3)]">
            客户端参考图转换与缓存协议尚未部署
          </p>
        </div>
      </div>

      {/* 卡片主体 */}
      <div className="card p-5">
        {/* 顶部：启用开关 + 状态 */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            {/* 启用开关 */}
            <button disabled className="relative w-11 h-6 rounded-full flex-shrink-0 bg-[var(--border)] cursor-not-allowed" aria-label="彩铅能力暂不可用">
              <span
                className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white"
              />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[var(--text)]">
                  彩铅链路安全停用
                </span>
                <span className="badge badge-muted">待支持</span>
              </div>
              <p className="text-xs text-[var(--text-3)] mt-0.5">
                已有彩铅缓存可只读保留；新转换、全局模式和无缓存资产不会伪装成功。
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between mt-4 pt-3 border-t border-[var(--border-light)]">
          <span className="text-xs text-[var(--text-3)]">需要客户端 I2I、缓存持久化和失败恢复协议后再开放</span>
        </div>
      </div>
    </div>
  );
}
