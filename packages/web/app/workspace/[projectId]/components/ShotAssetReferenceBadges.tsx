"use client";

/**
 * @file ShotAssetReferenceBadges.tsx — 镜头引用资产徽标（批6 Step 2，简化版）
 *
 * 镜像 app1 `F:\app1\src\app\workspace\[projectId]\components\ShotAssetReferenceBadges.tsx`
 * （79 行），唯一改动 OP2：`<Image>` → `<img>`。
 *
 * 原因：dramaforge 用 sf-asset://（Electron 自定义 protocol）直接显示资产图，next/image
 * 强制 https 远端 URL + 优化器对自定义 protocol 拒绝（甚至加 unoptimized 也会校验
 * hostname）。app1 用 `/api/.../image?v=` 代理 route，那 route 在 dramaforge 不存在
 * （OP3），且 dramaforge-assets-client-local 禁止 server 代理媒体字节。
 *
 * 双色方案：promptRef 序号使用 --action 蓝（与主操作按钮同色），kind 标签使用
 * --text-3 中性灰（视觉弱化，避免与组标题琥珀色冲突）。
 */

import * as React from 'react';
import { cn } from '../../../../components/ui/cn';
import type { ShotAssetReferenceBinding } from './shot-asset-reference';

const KIND_LABELS: Record<ShotAssetReferenceBinding['kind'], string> = {
  CHARACTER: '角色',
  LOCATION: '场景',
  PROP: '道具',
};

export function ShotAssetReferenceBadges({
  references,
  className,
  compact = false,
}: {
  references: ShotAssetReferenceBinding[];
  className?: string;
  compact?: boolean;
}) {
  if (!references.length) return null;

  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {references.map((reference) => {
        const previewUrl = reference.thumbnailUrl || reference.imageUrl || '';
        return (
          <div
            key={`${reference.kind}:${reference.assetId || reference.name}:${reference.promptRef}`}
            className="relative group"
          >
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-md border border-[var(--border-light)] bg-[var(--bg-hover)] px-2 py-1 text-[10px] text-[var(--text-2)] transition-colors',
                compact ? 'px-1.5 py-0.5' : '',
                previewUrl
                  ? 'cursor-default group-hover:border-[var(--action)]/40 group-hover:text-[var(--text)]'
                  : '',
              )}
            >
              <span className="font-mono text-[var(--action)]">{reference.promptRef}</span>
              <span>{reference.name}</span>
              {reference.costumeLabel && (
                <span className="text-[var(--text-3)]">· {reference.costumeLabel}</span>
              )}
              <span className="text-[var(--text-3)]">{KIND_LABELS[reference.kind]}</span>
            </span>

            {previewUrl && (
              <div className="pointer-events-none absolute left-0 top-full z-30 mt-2 w-56 translate-y-1 rounded-xl border border-[var(--border-light)] bg-[var(--bg-elevated)] p-2 opacity-0 shadow-2xl transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100">
                <div className="relative aspect-video overflow-hidden rounded-lg bg-[var(--bg-hover)]">
                  {/*
                   * OP2 必修：<img> 而非 <Image>。
                   * sf-asset:// 是 Electron 自定义 protocol，next/image 强制 https
                   * + hostname 校验会拒绝。app1 用代理 route + unoptimized，dramaforge 无
                   * 代理 route（OP3/server 不碰字节）+ 自定义 protocol 必须裸 <img>。
                   */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={previewUrl}
                    alt={reference.name}
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                </div>
                <div className="mt-2 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-[var(--action-dim)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--action)]">
                      {reference.promptRef}
                    </span>
                    <span className="text-xs font-medium text-[var(--text)]">{reference.name}</span>
                    {reference.costumeLabel && (
                      <span className="text-[10px] text-[var(--accent)]">· {reference.costumeLabel}</span>
                    )}
                  </div>
                  <div className="text-[10px] text-[var(--text-3)]">
                    {KIND_LABELS[reference.kind]}
                    {reference.assetType ? ` · ${reference.assetType}` : ''}
                  </div>
                  {reference.description && (
                    <div className="line-clamp-3 text-[11px] leading-relaxed text-[var(--text-2)]">
                      {reference.description}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
