/**
 * @file Input.tsx
 * @description 输入框 + 标签 + 文本域 + 表单字段组件
 *
 * 统一的表单基础控件，替代散落各处的手写 input/textarea/label。
 * 遵循双色方案铁律：可点击行为使用 --action（蓝色），身份/品牌层使用 --accent（琥珀）。
 * 默认控件本身为中性色，仅在 focus 态用 --action 描边表示"可交互"。
 *
 * @example
 * <Input value={v} onChange={...} placeholder="请输入" />
 * <Textarea rows={4} value={v} onChange={...} />
 * <FormField label="项目名称" hint="3-30 字符" required>
 *   <Input value={v} onChange={...} />
 * </FormField>
 */
import * as React from "react";
import { cn } from "./cn";

// ============================================================
// Input
// ============================================================

// Omit<"prefix">：原生 HTMLAttributes.prefix 是 string（<object> 的属性），
// 与此处的 ReactNode 图标槽位冲突。app1 源文件未做此 Omit（其 typecheck 本就
// 不绿）；dramaforge 的 P1 gate 要求 typecheck 通过，故在此最小修正——仅剔除无关的
// 原生属性，不影响 prefix 槽位的运行时行为。
export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否显示错误态（红色描边） */
  invalid?: boolean;
  /** 输入框前缀图标（如货币符号、搜索图标） */
  prefix?: React.ReactNode;
  /** 输入框后缀图标或按钮 */
  suffix?: React.ReactNode;
}

/**
 * 统一文本输入框
 *
 * 默认中性色，focus 时使用 --action 蓝色描边（可交互行为色）。
 * 支持 prefix/suffix 槽位用于图标、单位、清除按钮等。
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, disabled, invalid, prefix, suffix, ...props }, ref) => {
    // 有前后缀时用包裹布局，否则单 input
    if (!prefix && !suffix) {
      return (
        <input
          ref={ref}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          className={cn(
            "w-full h-9 px-3 text-sm rounded-[var(--radius-sm)]",
            "bg-[var(--bg-input)] text-[var(--text)] placeholder:text-[var(--text-3)]",
            "border border-[var(--border-strong)]",
            "focus:outline-none focus:border-[var(--action)] focus:ring-2 focus:ring-[var(--action)]/20",
            "transition-colors",
            "disabled:cursor-not-allowed disabled:opacity-50",
            invalid && "border-[var(--error)] focus:border-[var(--error)] focus:ring-[var(--error)]/20",
            className,
          )}
          {...props}
        />
      );
    }

    return (
      <div
        className={cn(
          "flex items-center w-full h-9 px-3 text-sm rounded-[var(--radius-sm)]",
          "bg-[var(--bg-input)] text-[var(--text)] placeholder:text-[var(--text-3)]",
          "border border-[var(--border-strong)]",
          "focus-within:border-[var(--action)] focus-within:ring-2 focus-within:ring-[var(--action)]/20",
          "transition-colors",
          "disabled:opacity-50",
          invalid && "border-[var(--error)] focus-within:border-[var(--error)] focus-within:ring-[var(--error)]/20",
          className,
        )}
        aria-invalid={invalid || undefined}
      >
        {prefix && <span className="flex-shrink-0 mr-2 text-[var(--text-3)]">{prefix}</span>}
        <input
          ref={ref}
          disabled={disabled}
          className="flex-1 min-w-0 bg-transparent border-0 outline-none placeholder:text-[var(--text-3)] text-[var(--text)]"
          {...props}
        />
        {suffix && <span className="flex-shrink-0 ml-2 text-[var(--text-3)]">{suffix}</span>}
      </div>
    );
  },
);
Input.displayName = "Input";

// ============================================================
// Textarea
// ============================================================

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否显示错误态 */
  invalid?: boolean;
}

/**
 * 统一多行文本域
 *
 * 视觉与 Input 保持一致，默认 4 行高度，支持自动纵向拉伸。
 */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, disabled, invalid, rows = 4, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        rows={rows}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cn(
          "w-full px-3 py-2 text-sm rounded-[var(--radius-sm)] resize-y",
          "bg-[var(--bg-input)] text-[var(--text)] placeholder:text-[var(--text-3)]",
          "border border-[var(--border-strong)]",
          "focus:outline-none focus:border-[var(--action)] focus:ring-2 focus:ring-[var(--action)]/20",
          "transition-colors",
          "disabled:cursor-not-allowed disabled:opacity-50",
          invalid && "border-[var(--error)] focus:border-[var(--error)] focus:ring-[var(--error)]/20",
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

// ============================================================
// Label
// ============================================================

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  /** 是否标记为必填（追加红色 *） */
  required?: boolean;
}

/**
 * 表单标签
 *
 * 默认 --text-2 中性色；必填字段的 * 使用 --error 红。
 * 不使用 --action/--accent 以保持标签为"信息层"而非"行为层"。
 */
export function Label({ className, required, children, ...props }: LabelProps) {
  return (
    <label
      className={cn("block text-sm font-medium text-[var(--text-2)] mb-1.5", className)}
      {...props}
    >
      {children}
      {required && <span className="text-[var(--error)] ml-0.5">*</span>}
    </label>
  );
}

// ============================================================
// FormField
// ============================================================

export interface FormFieldProps {
  /** 标签文案 */
  label?: React.ReactNode;
  /** 标签右侧的提示文案（如格式说明） */
  hint?: React.ReactNode;
  /** 错误文案（传入时显示红色错误行） */
  error?: React.ReactNode;
  /** 是否必填（在标签后追加 *） */
  required?: boolean;
  /** 子元素（通常为 Input/Textarea/Select） */
  children?: React.ReactNode;
  /** 容器额外类名 */
  className?: string;
}

/**
 * 表单字段容器
 *
 * 组合 Label + 控件 + 错误提示，统一表单行的纵向节奏。
 * 不接管控件的状态，仅做视觉包装。
 */
export function FormField({ label, hint, error, required, children, className }: FormFieldProps) {
  return (
    <div className={cn("flex flex-col", className)}>
      {(label || hint) && (
        <div className="flex items-center justify-between mb-1.5">
          {label && <Label required={required}>{label}</Label>}
          {hint && <span className="text-xs text-[var(--text-3)]">{hint}</span>}
        </div>
      )}
      {children}
      {error && <p className="mt-1.5 text-xs text-[var(--error)]">{error}</p>}
    </div>
  );
}
