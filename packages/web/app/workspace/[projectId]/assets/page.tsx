"use client";

/**
 * @file workspace/[projectId]/assets/page.tsx — 资产总表路由（薄壳）
 *
 * 渲染逻辑已抽取到 components/AssetMasterPanel.tsx（与 AssetDesignStage
 * 的 [资产设定 | 资产总表] 视图共用）。本文件仅负责：鉴权门 + 面包屑 +
 * 标题 + 挂载面板。
 *
 * 出场集从 shots 派生（见 server domain/asset/appearance.ts）。
 * 媒体：asset.imageUrl 为 sf-asset://（Electron 本地，H1）；web 预览可能不显示，正常。
 */

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { Spinner } from "../../../../components/ui/Spinner";
import { AssetMasterPanel } from "../components/AssetMasterPanel";

export default function AssetMasterPage() {
  const params = useParams();
  const projectId = params?.projectId as string;
  const { status } = useSession();

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
        <Link href="/auth/signin" className="text-[var(--action)] hover:underline">去登录</Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex flex-col px-6 py-8 max-w-6xl mx-auto">
      {/* 面包屑 + 标题 */}
      <header className="flex items-center gap-3 mb-5 flex-wrap">
        <Link href={`/workspace/${encodeURIComponent(projectId)}`} className="text-sm text-[var(--text-3)] hover:text-[var(--action)] transition-colors flex items-center gap-1 flex-shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          返回项目
        </Link>
        <span className="text-[var(--text-3)] text-xs">/</span>
        <h1 className="text-xl font-bold text-[var(--text)]">资产总表</h1>
      </header>

      <AssetMasterPanel projectId={projectId} className="flex-1 min-h-0" />
    </main>
  );
}
