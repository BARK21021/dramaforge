"use client";

/**
 * @file groups/page.tsx — 全局镜头组库页面（批9 Step 1，镜像 app1）
 *
 * 镜像源：F:\app1\src\app\groups\page.tsx (67 行)
 *
 * 聚合展示当前用户所有项目下「整组已生成成功」的镜头组（dramaforge 一集 = 一个
 * CHAIN_COMPILE 成片；CONCAT 单镜导出也收入），与成片库分开。
 * 复用 GroupLibraryPanel（全局模式）。数据来源：GET /api/groups。
 * 分组方式：按 项目 → 分集 分组，组内按 updatedAt 升序（同集多次生成 N=1,2,3…）。
 *
 * 与 app1 的差异：
 *   - dramaforge 在 AppShell 已注入左侧 sidebar，本页 AppHeader 在内容区顶部（与
 *     workspace/page.tsx 同构）。
 *   - 返回按钮逻辑：history.length>1 时 router.back()，否则 push('/workspace')。
 *
 * 路由：/groups
 */

import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AppHeader } from "../../components/layout/AppHeader";
import { CreditsBadge } from "../../components/ui/CreditsBadge";
import { GroupLibraryPanel } from "../workspace/[projectId]/components/GroupLibraryPanel";

export default function GroupsPage() {
  const router = useRouter();

  return (
    <div className="flex-1 bg-[var(--bg)] flex flex-col overflow-hidden">
      <AppHeader
        left={
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
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
            <span className="font-bold text-[var(--text)]">镜头组库</span>
          </div>
        }
        right={
          <>
            <CreditsBadge size="lg" />
            <Link
              href="/workspace"
              className="text-xs sm:text-sm text-[var(--text-2)] hover:text-[var(--text)] transition-colors inline-flex items-center gap-1 px-2 py-1.5 rounded-md hover:bg-[var(--bg-hover)]"
              title="返回工作区"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path
                  d="M3 12h18M3 6h18M3 18h18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="hidden sm:inline">工作区</span>
            </Link>
          </>
        }
      />
      <main className="flex-1 overflow-hidden flex flex-col">
        <GroupLibraryPanel onBack={() => router.back()} />
      </main>
    </div>
  );
}
