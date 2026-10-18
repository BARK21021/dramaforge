"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useSession } from "next-auth/react";
import * as React from "react";
import { AppHeader } from "../components/layout/AppHeader";
import { useToast } from "../components/ui/Toast";
import { FORCE_LOGOUT_REASON_KEY } from "../lib/force-logout";

// ============================================================
// DramaForge · 电影级极简落地页
// ------------------------------------------------------------
// 取向（用户）：精简的美 + 满屏动效/特效。
//   - 文字砍到极致：仅一句标题 + 一个 CTA，其余全删。
//   - 动效拉满（全部常驻、GPU 安全 transform/opacity）：
//     1) Canvas 金尘粒子场（鼠标视差，电影感核心特效）
//     2) 双层金色光环（缓慢反向旋转，标题背后）
//     3) 金/余烬光球漂移 + 鼠标分层视差（远/中/近三档景深）
//     4) 标题逐字入场 + 金属光泽常驻流光
//     5) 横扫光束 ×2
//     6) CTA 呼吸辉光环
//     7) 底部声波条呼吸（影视工坊主题）
//     8) 暗角 + 颗粒，电影质感
//     prefers-reduced-motion → 全部冻结为静态。
// ============================================================

const LINE1 = "为出海内容";
const LINE2 = "重塑每一帧";

export default function HomePage() {
  const { status } = useSession();
  const primaryHref = status === "authenticated" ? "/workspace" : "/auth/signin";
  const primaryLabel = status === "authenticated" ? "进入工作区" : "开始创作";

  // 强退原因：SessionGuard 在会话失效（改密/过期/挤下线）时往 sessionStorage 写
  // 原因后 signOut 跳本页；此处挂载时读出弹 toast 再清除，避免静默弹走像 bug。
  const toast = useToast();
  React.useEffect(() => {
    try {
      const reason = sessionStorage.getItem(FORCE_LOGOUT_REASON_KEY);
      if (reason) {
        sessionStorage.removeItem(FORCE_LOGOUT_REASON_KEY);
        toast.warning(reason);
      }
    } catch {
      /* sessionStorage 不可用时静默 */
    }
  }, [toast]);

  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const mouse = React.useRef({ x: 0.5, y: 0.5 });

  // Canvas 金尘粒子场 + 鼠标视差（核心特效）
  React.useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const COUNT = window.innerWidth < 768 ? 42 : 88;
    const parts = Array.from({ length: COUNT }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      z: Math.random() * 0.8 + 0.2, // 景深 0.2–1
      r: Math.random() * 1.5 + 0.4,
      a: Math.random() * 0.5 + 0.2,
      vx: (Math.random() - 0.5) * 0.14,
      vy: (Math.random() - 0.5) * 0.1 - 0.03,
      tw: Math.random() * Math.PI * 2,
      ts: Math.random() * 0.02 + 0.004,
    }));

    let raf = 0;
    const render = () => {
      ctx.clearRect(0, 0, w, h);
      const mx = mouse.current.x - 0.5;
      const my = mouse.current.y - 0.5;
      for (const p of parts) {
        p.x += p.vx;
        p.y += p.vy;
        p.tw += p.ts;
        if (p.x < -10) p.x = w + 10;
        if (p.x > w + 10) p.x = -10;
        if (p.y < -10) p.y = h + 10;
        if (p.y > h + 10) p.y = -10;
        const twinkle = (Math.sin(p.tw) + 1) / 2;
        const alpha = p.a * (0.35 + 0.65 * twinkle);
        const px = p.x + mx * 36 * p.z;
        const py = p.y + my * 36 * p.z;
        ctx.beginPath();
        ctx.arc(px, py, p.r * p.z, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(245, 210, 122, ${alpha})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(render);
    };

    if (reduce) {
      // 静态：画一帧
      for (const p of parts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(245, 210, 122, ${p.a * 0.5})`;
        ctx.fill();
      }
    } else {
      render();
    }

    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  // 鼠标位置 → CSS 变量（分层视差 + 粒子视差共用）
  React.useEffect(() => {
    const onMove = (e: MouseEvent) => {
      mouse.current.x = e.clientX / window.innerWidth;
      mouse.current.y = e.clientY / window.innerHeight;
      const root = rootRef.current;
      if (root) {
        root.style.setProperty("--px", String(mouse.current.x - 0.5));
        root.style.setProperty("--py", String(mouse.current.y - 0.5));
      }
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  return (
    <div
      ref={rootRef}
      className="sf-root relative min-h-[100dvh] overflow-hidden bg-[#070609] text-white"
      style={{ "--px": "0", "--py": "0" } as React.CSSProperties}
    >
      {/* 背景：深墨底 + 居中暖光 */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(212,175,55,0.12),transparent_55%),linear-gradient(180deg,#0a090d_0%,#070609_60%,#040305_100%)]" />
      </div>

      {/* Canvas 金尘粒子场（最底层特效） */}
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-[1]" aria-hidden="true" />

      {/* 视差层·远：极光雾 + 光球 + 光束 */}
      <div className="layer-far pointer-events-none absolute inset-0 z-[2]" aria-hidden="true">
        <div className="aurora" />
        <div className="orb orb-a" />
        <div className="orb orb-b" />
        <div className="orb orb-c" />
        <div className="beam beam-1" />
        <div className="beam beam-2" />
      </div>

      {/* 视差层·中：双层光环（标题背后） */}
      <div
        className="layer-mid pointer-events-none absolute inset-0 z-[3] flex items-center justify-center"
        aria-hidden="true"
      >
        <div className="halo" />
        <div className="halo-ring" />
      </div>

      {/* 暗角（电影质感，压在特效上、内容下） */}
      <div className="vignette" aria-hidden="true" />

      {/* 内容 */}
      <div className="relative z-10 flex min-h-[100dvh] flex-col">
        <AppHeader
          bordered={false}
          right={
            status === "authenticated" ? (
              <Link
                href="/workspace"
                className="fade-in rounded-full border border-white/20 bg-white/[0.05] px-6 py-2.5 text-base font-semibold text-white backdrop-blur-sm transition-all duration-500 hover:border-white/40 hover:bg-white/[0.1]"
              >
                进入工作区
              </Link>
            ) : (
              <Link
                href="/auth/signin"
                className="fade-in rounded-full border border-white/20 bg-white/[0.05] px-6 py-2.5 text-base font-semibold text-white backdrop-blur-sm transition-all duration-500 hover:border-white/40 hover:bg-white/[0.1]"
              >
                登录
              </Link>
            )
          }
        />

        {/* 居中英雄区（近景视差层） */}
        <main className="layer-near flex flex-1 flex-col items-center justify-center px-5 text-center">
          {/* 极小 eyebrow */}
          <p className="eyebrow fade-in" style={{ animationDelay: "0.1s" }}>
            <span className="eyebrow-dot" />
            DRAMAFORGE STUDIO · AI 出海内容工坊
          </p>

          {/* 巨号衬线标题：逐字入场 + 金属流光 */}
          <h1
            className="font-editorial mt-8 text-[3.4rem] font-bold leading-[1.04] tracking-[-0.02em] text-white sm:text-7xl lg:text-[6.5rem]"
            style={{ perspective: "1000px" }}
          >
            <span className="hl-line">
              {LINE1.split("").map((ch, i) => (
                <span key={i} className="hl-char" style={{ animationDelay: `${0.45 + i * 0.07}s` }}>
                  {ch}
                </span>
              ))}
            </span>
            <span className="hl-line">
              {LINE2.split("").map((ch, i) => (
                <span
                  key={i}
                  className="hl-char hl-char-gold"
                  style={{
                    animationDelay: `${0.45 + (LINE1.length + i) * 0.07}s, ${i * 0.4}s`,
                  }}
                >
                  {ch}
                </span>
              ))}
            </span>
          </h1>

          {/* 唯一 CTA：磁吸辉光 */}
          <Link
            href={primaryHref}
            className="cta-magnetic group fade-in mt-14 inline-flex items-center gap-3.5 rounded-full pl-9 pr-3.5 py-4 text-lg font-bold tracking-wide text-[#f7d98a]"
            style={{ animationDelay: "1.2s" }}
          >
            {primaryLabel}
            <span className="cta-arrow">
              <ArrowRight size={20} strokeWidth={2.2} />
            </span>
          </Link>
        </main>

        {/* 底部声波条（影视工坊主题，常驻呼吸） */}
        <div
          className="relative z-10 flex h-16 items-end justify-center gap-[3px] pb-8"
          aria-hidden="true"
        >
          {Array.from({ length: 9 }).map((_, i) => (
            <span key={i} className="wave-bar" style={{ animationDelay: `${i * 0.13}s` }} />
          ))}
        </div>
      </div>

      {/* 颗粒（最顶层，胶片质感） */}
      <div className="grain" aria-hidden="true" />

      <style jsx>{`
        /* ===== 字体：编辑级衬线（Latin→Playfair；CJK→宋体族，绝不回落无衬线） ===== */
        .font-editorial {
          font-family: "Playfair Display", "Cormorant Garamond", "Songti SC",
            "Source Han Serif SC", "Noto Serif SC", "STSong", "SimSun", "NSimSun",
            "FangSong", Georgia, "Times New Roman", serif;
          font-feature-settings: "liga" 1, "dlig" 1;
        }

        /* ===== 暗角（电影质感） ===== */
        .vignette {
          position: fixed;
          inset: 0;
          z-index: 4;
          pointer-events: none;
          background: radial-gradient(
            ellipse at center,
            transparent 48%,
            rgba(0, 0, 0, 0.6) 100%
          );
        }

        /* ===== 颗粒（fixed，顶层） ===== */
        .grain {
          position: fixed;
          inset: 0;
          z-index: 60;
          pointer-events: none;
          opacity: 0.05;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
        }

        /* ===== 鼠标分层视差（远/中/近三档景深） ===== */
        .layer-far {
          transform: translate3d(
            calc(var(--px, 0) * 10px),
            calc(var(--py, 0) * 10px),
            0
          );
          transition: transform 1.1s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .layer-mid {
          transform: translate3d(
            calc(var(--px, 0) * 26px),
            calc(var(--py, 0) * 26px),
            0
          );
          transition: transform 1.1s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .layer-near {
          transform: translate3d(
            calc(var(--px, 0) * 42px),
            calc(var(--py, 0) * 42px),
            0
          );
          transition: transform 1.1s cubic-bezier(0.22, 1, 0.36, 1);
        }

        /* ===== 金色极光雾（缓慢旋转） ===== */
        .aurora {
          position: absolute;
          inset: -25%;
          background: conic-gradient(
            from 0deg at 50% 50%,
            rgba(212, 175, 55, 0) 0deg,
            rgba(212, 175, 55, 0.13) 60deg,
            rgba(245, 210, 122, 0) 160deg,
            rgba(200, 147, 47, 0.11) 240deg,
            rgba(212, 175, 55, 0) 360deg
          );
          filter: blur(70px);
          animation: auroraSpin 48s linear infinite;
          will-change: transform;
        }

        /* ===== 光球：金/余烬，漂移（transform-only） ===== */
        .orb {
          position: absolute;
          border-radius: 9999px;
          filter: blur(72px);
          will-change: transform;
        }
        .orb-a {
          top: -6%;
          left: 8%;
          width: 24rem;
          height: 24rem;
          background: radial-gradient(circle, rgba(212, 175, 55, 0.5), transparent 65%);
          animation: driftA 26s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
        }
        .orb-b {
          right: 6%;
          top: 4%;
          width: 28rem;
          height: 28rem;
          background: radial-gradient(circle, rgba(200, 147, 47, 0.4), transparent 66%);
          animation: driftB 32s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
        }
        .orb-c {
          left: 38%;
          bottom: -16%;
          width: 22rem;
          height: 22rem;
          background: radial-gradient(circle, rgba(245, 210, 122, 0.3), transparent 68%);
          animation: driftC 28s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
        }

        /* ===== 横扫光束 ×2 ===== */
        .beam {
          position: absolute;
          top: -25%;
          width: 50%;
          height: 150%;
          background: linear-gradient(
            100deg,
            transparent,
            rgba(245, 210, 122, 0.09) 45%,
            rgba(255, 255, 255, 0.07) 50%,
            rgba(245, 210, 122, 0.09) 55%,
            transparent
          );
        }
        .beam-1 {
          left: -30%;
          transform: rotate(18deg);
          animation: beamSweep 13s ease-in-out infinite;
        }
        .beam-2 {
          right: -30%;
          transform: rotate(-22deg);
          animation: beamSweep2 17s ease-in-out infinite;
        }

        /* ===== 双层光环（标题背后，电影感） ===== */
        .halo {
          position: absolute;
          width: 58vmin;
          height: 58vmin;
          border-radius: 9999px;
          border: 1px solid rgba(245, 210, 122, 0.1);
          box-shadow: inset 0 0 90px rgba(245, 210, 122, 0.07),
            0 0 140px rgba(212, 175, 55, 0.05);
        }
        .halo::before {
          content: "";
          position: absolute;
          inset: -1px;
          border-radius: 9999px;
          background: conic-gradient(
            from 0deg,
            transparent,
            rgba(245, 210, 122, 0.32),
            transparent 28%
          );
          animation: haloSpin 26s linear infinite;
          -webkit-mask: radial-gradient(circle, transparent 58%, #000 59%, #000 100%);
          mask: radial-gradient(circle, transparent 58%, #000 59%, #000 100%);
        }
        .halo-ring {
          position: absolute;
          width: 82vmin;
          height: 82vmin;
          border-radius: 9999px;
          border: 1px dashed rgba(245, 210, 122, 0.08);
          animation: haloSpinR 60s linear infinite;
        }

        /* ===== Eyebrow ===== */
        .eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          font-size: 12px;
          letter-spacing: 0.26em;
          text-transform: uppercase;
          color: rgba(245, 210, 122, 0.82);
          font-weight: 600;
        }
        .eyebrow-dot {
          width: 6px;
          height: 6px;
          border-radius: 9999px;
          background: #f5d27a;
          box-shadow: 0 0 10px rgba(245, 210, 122, 0.9);
          animation: livePulse 1.9s ease-in-out infinite;
        }

        /* ===== 标题：逐字入场 ===== */
        .hl-line {
          display: block;
        }
        .hl-char {
          display: inline-block;
          opacity: 0;
          will-change: transform, opacity;
          animation: charIn 0.9s cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        .hl-char-gold {
          background: linear-gradient(
            100deg,
            #b8893a 0%,
            #f5d27a 22%,
            #fff6dc 32%,
            #f5d27a 46%,
            #c8932f 62%,
            #b8893a 100%
          );
          background-size: 220% auto;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          color: transparent;
          animation: charIn 0.9s cubic-bezier(0.22, 1, 0.36, 1) forwards,
            shimmer 5s linear infinite;
        }

        /* ===== CTA：磁吸 + 呼吸辉光环 ===== */
        .cta-magnetic {
          position: relative;
          background: linear-gradient(180deg, rgba(26, 21, 13, 0.96), rgba(8, 6, 4, 0.98));
          border: 2px solid rgba(245, 210, 122, 0.62);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          box-shadow: 0 10px 36px rgba(0, 0, 0, 0.45),
            0 0 28px rgba(212, 175, 55, 0.22),
            inset 0 1px 0 rgba(255, 255, 255, 0.08);
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
          transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1),
            box-shadow 0.5s ease, border-color 0.5s ease;
        }
        .cta-magnetic::after {
          content: "";
          position: absolute;
          inset: -5px;
          border-radius: 9999px;
          background: radial-gradient(circle, rgba(245, 210, 122, 0.4), transparent 70%);
          opacity: 0.4;
          z-index: -1;
          animation: ctaPulse 3.6s ease-in-out infinite;
        }
        .cta-magnetic:hover {
          transform: translateY(-3px) scale(1.02);
          border-color: rgba(245, 210, 122, 0.85);
          box-shadow: 0 16px 52px rgba(0, 0, 0, 0.5),
            0 0 42px rgba(212, 175, 55, 0.35),
            inset 0 1px 0 rgba(255, 255, 255, 0.12);
        }
        .cta-magnetic:active {
          transform: translateY(0) scale(0.98);
        }
        .cta-arrow {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          border-radius: 9999px;
          background: linear-gradient(135deg, #f7d98a, #d9a84a);
          color: #1a1408;
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.4);
          transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .cta-magnetic:hover .cta-arrow {
          transform: translateX(4px);
        }

        /* ===== 底部声波条 ===== */
        .wave-bar {
          width: 3px;
          height: 28px;
          border-radius: 2px;
          background: linear-gradient(180deg, #f5d27a, #b8893a);
          opacity: 0.5;
          transform: scaleY(0.3);
          transform-origin: bottom;
          animation: wave 1.3s ease-in-out infinite;
        }

        /* ===== 入场淡入 ===== */
        .fade-in {
          opacity: 0;
          animation: fadeIn 1s ease forwards;
        }

        /* ===== Keyframes（仅 transform / opacity / background-position） ===== */
        @keyframes fadeIn {
          to {
            opacity: 1;
          }
        }
        @keyframes charIn {
          from {
            opacity: 0;
            transform: translateY(0.45em);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes shimmer {
          to {
            background-position: -220% center;
          }
        }
        @keyframes auroraSpin {
          to {
            transform: rotate(360deg);
          }
        }
        @keyframes haloSpin {
          to {
            transform: rotate(360deg);
          }
        }
        @keyframes haloSpinR {
          to {
            transform: rotate(-360deg);
          }
        }
        @keyframes driftA {
          0%, 100% {
            transform: translate3d(0, 0, 0) scale(1);
          }
          50% {
            transform: translate3d(40px, 50px, 0) scale(1.14);
          }
        }
        @keyframes driftB {
          0%, 100% {
            transform: translate3d(0, 0, 0) scale(1.05);
          }
          50% {
            transform: translate3d(-46px, 36px, 0) scale(0.92);
          }
        }
        @keyframes driftC {
          0%, 100% {
            transform: translate3d(0, 0, 0) scale(1);
          }
          50% {
            transform: translate3d(30px, -40px, 0) scale(1.12);
          }
        }
        @keyframes beamSweep {
          0% {
            transform: translateX(-60%) rotate(18deg);
            opacity: 0;
          }
          40% {
            opacity: 1;
          }
          60% {
            opacity: 1;
          }
          100% {
            transform: translateX(220%) rotate(18deg);
            opacity: 0;
          }
        }
        @keyframes beamSweep2 {
          0% {
            transform: translateX(60%) rotate(-22deg);
            opacity: 0;
          }
          40% {
            opacity: 1;
          }
          60% {
            opacity: 1;
          }
          100% {
            transform: translateX(-220%) rotate(-22deg);
            opacity: 0;
          }
        }
        @keyframes livePulse {
          0%, 100% {
            opacity: 1;
            transform: scale(1);
          }
          50% {
            opacity: 0.35;
            transform: scale(0.78);
          }
        }
        @keyframes ctaPulse {
          0%, 100% {
            opacity: 0.3;
            transform: scale(0.96);
          }
          50% {
            opacity: 0.6;
            transform: scale(1.08);
          }
        }
        @keyframes wave {
          0%, 100% {
            transform: scaleY(0.3);
            opacity: 0.3;
          }
          50% {
            transform: scaleY(1);
            opacity: 0.75;
          }
        }

        /* ===== 无障碍：减弱动效 → 冻结为静态终态 ===== */
        @media (prefers-reduced-motion: reduce) {
          .orb,
          .aurora,
          .beam,
          .halo::before,
          .halo-ring,
          .hl-char,
          .hl-char-gold,
          .eyebrow-dot,
          .cta-magnetic::after,
          .wave-bar {
            animation: none !important;
          }
          .hl-char,
          .fade-in {
            opacity: 1;
          }
          .wave-bar {
            transform: scaleY(0.6);
          }
        }
      `}</style>
    </div>
  );
}
