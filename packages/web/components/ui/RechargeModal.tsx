/**
 * @file RechargeModal.tsx
 * @description 额度不足充值弹窗（P6 新增，对齐 app1 视觉）
 *
 * 当 AI 提供商返回额度不足错误时，后端透传 providerName + rechargeUrl，
 * 前端通过此弹窗展示二维码供用户扫码前往对应官网充值。
 *
 * 与 PlatformRechargeModal 的区别：
 * - PlatformRechargeModal：平台自营积分商城（4 桡位 + 支付宝收银台跳转，
 *   POST /api/payment/orders 建单）。用户主动点 CreditsBadge 的「充值」触发。
 * - RechargeModal（本组件）：第三方 AI 提供商额度不足的错误弹窗（如 DeepSeek
 *   余额不足）。显示 QRCodeSVG + 提供商官网充值链接 + 「已充值，重试」。
 *   由 RechargeProvider 在 showRecharge({providerName, rechargeUrl, ...}) 时渲染。
 *
 * 功能：
 * - 显示提供商名称和错误提示
 * - 用 QRCodeSVG 渲染充值链接二维码（纯客户端生成，无网络请求）
 * - 提供「前往充值页面」链接（新标签打开）
 * - 提供「已充值，重试」按钮（如有 onRetry 回调）
 *
 * QR 安全：rechargeUrl 由后端硬编码（provider-recharge.ts），不接受用户输入，
 * 无中间人风险。qrcode.react 纯客户端生成，不发送任何数据到外部。
 *
 * 与 app1 差异：dramaforge Modal 无 ModalFooter 导出（按 ConfirmDialog 先例内联 flex
 * 容器）；onClose 签名 () => void 不变（Modal 内部 (open:boolean)=>void 兼容）。
 */
"use client";

import { Modal } from "./Modal";
import { QRCodeSVG } from "qrcode.react";
import { ExternalLink, RefreshCw } from "lucide-react";

export interface RechargeModalProps {
  /** 是否打开 */
  open: boolean;
  /** AI 提供商展示名（如 "DeepSeek"） */
  providerName?: string;
  /** 提供商官方充值页 URL */
  rechargeUrl?: string;
  /** 错误消息（rechargeUrl 缺失时展示） */
  errorMessage?: string;
  /** 已充值后的重试回调（不传则不显示重试按钮） */
  onRetry?: () => void;
  /** 关闭回调 */
  onClose: () => void;
}

/**
 * 额度不足充值弹窗
 *
 * 当 rechargeUrl 存在时显示二维码 + 充值链接；
 * 否则仅显示文字提示（如本地部署 comfyui 无充值入口的场景）。
 */
export function RechargeModal({
  open,
  providerName,
  rechargeUrl,
  errorMessage,
  onRetry,
  onClose,
}: RechargeModalProps) {
  const title = providerName
    ? `${providerName} 账户额度不足`
    : "AI 服务额度不足";

  return (
    <Modal open={open} onClose={onClose} title={title} maxWidthClassName="max-w-md">
      <div className="flex flex-col items-center gap-4 py-2">
        {rechargeUrl ? (
          <>
            <p className="text-sm text-[var(--text-2)] text-center leading-relaxed">
              请扫码前往{providerName}官网充值，充值完成后点击&ldquo;已充值，重试&rdquo;
            </p>
            {/* 白色背景确保深色模式下二维码可扫描 */}
            <div className="p-3 bg-white rounded-lg">
              <QRCodeSVG value={rechargeUrl} size={180} />
            </div>
            <a
              href={rechargeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-[var(--action)] hover:underline flex items-center gap-1"
            >
              <ExternalLink size={14} />
              前往充值页面
            </a>
          </>
        ) : (
          <p className="text-sm text-[var(--text-2)] text-center">
            {errorMessage || "请前往对应 AI 服务商官网充值后重试"}
          </p>
        )}
      </div>
      {/* ModalFooter 等价（dramaforge Modal 无 ModalFooter 导出，按 ConfirmDialog 先例内联） */}
      <div className="flex gap-3 justify-end pt-4">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm rounded-lg hover:bg-[var(--bg-hover)] transition-colors"
        >
          取消
        </button>
        {onRetry && (
          <button
            onClick={onRetry}
            className="btn-brand px-4 py-2 text-sm rounded-[var(--radius-sm)] flex items-center gap-1.5"
          >
            <RefreshCw size={14} />
            已充值，重试
          </button>
        )}
      </div>
    </Modal>
  );
}
