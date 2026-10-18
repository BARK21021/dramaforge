"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AppHeader } from "../../components/layout/AppHeader";
import { CreditsBadge } from "../../components/ui/CreditsBadge";
import { FilmLibraryPanel } from "../workspace/[projectId]/components/FilmLibraryPanel";

/** 当前用户跨项目的全局成片库。 */
export default function FilmsPage() {
  const router = useRouter();

  return (
    <div className="flex-1 bg-[var(--bg)] flex flex-col overflow-hidden">
      <AppHeader
        left={
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                if (window.history.length > 1) router.back();
                else router.push("/workspace");
              }}
              className="text-sm text-[var(--text-3)] hover:text-[var(--text)] transition-colors flex items-center gap-2"
              aria-label="返回"
            >
              <ArrowLeft size={20} />
              <span className="hidden sm:inline">返回</span>
            </button>
            <div className="w-px h-5 bg-[var(--border)]" aria-hidden="true" />
            <span className="font-bold text-[var(--text)]">全局成片库</span>
          </div>
        }
        right={
          <>
            <CreditsBadge size="lg" />
            <Link
              href="/workspace"
              className="text-xs sm:text-sm text-[var(--text-2)] hover:text-[var(--text)] transition-colors inline-flex items-center gap-1 px-2 py-1.5 rounded-md hover:bg-[var(--bg-hover)]"
            >
              工作区
            </Link>
          </>
        }
      />
      <main className="flex-1 overflow-hidden flex flex-col">
        <FilmLibraryPanel
          projectId={null}
          onNavigateBack={() => router.back()}
        />
      </main>
    </div>
  );
}
