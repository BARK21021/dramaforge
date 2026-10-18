"use client";

/**
 * @file ModelSelector.tsx — 模型下拉选择器（对齐 app1 视觉，dramaforge GC-1 简化版）
 *
 * ============================================================
 * 设计来源与差异（vs app1 F:\app1\src\components\features\ModelSelector.tsx）
 * ============================================================
 * app1 的 ModelSelector 自带 useApiConfigs Hook —— 查询用户在 settings 里自配
 * 的 provider key（BYOK），过滤掉未配置 key 的模型，并在选中未配置模型时弹
 * 「⚠ 需配置」警告链接。整套逻辑依赖 app1 的 /api/user/api-configs + settings
 * 页的 ProviderCard。
 *
 * dramaforge 是 **GC-1**（key 云端，无 BYOK）：平台已在云端为 Kimi / DeepSeek /
 * ARK 三个 provider 配好 key，用户不能也不需要自己配。目录内模型恒可用，
 * 故：
 *   - 删 useApiConfigs Hook（不查 /api/user/api-configs）
 *   - 删 isProviderReady 过滤（所有 provider 恒就绪）
 *   - 删「⚠ 需配置」链接（无 settings/api-configs 页可跳）
 *   - 删 ComfyUI 模式查询（dramaforge 未接入 comfyui provider）
 * 用户选模型 → 透传 model id 到 API → 服务器用云端 key 调。
 *
 * ============================================================
 * 视觉铁律（与 app1 / dramaforge globals.css 一致）
 * ============================================================
 *   - --accent 琥珀 #f59e0b = 身份/品牌层（能力徽章、积分徽章）
 *   - --action  蓝色 #3b82f6 = 可点击/交互语义（定价徽章、聚焦描边）
 *   - --text-3 slate-500 = 弱化辅助文字（速率、上限）
 * 单色徽章规则：能力=琥珀、定价=蓝、积分=琥珀、辅助=灰。绝不混用。
 *
 * ============================================================
 * 增强（基于 lib/models.ts 的丰富字段）
 * ============================================================
 * 当前 60 行存根只渲染裸 <select>，未利用 models.ts 的 pricing/capabilities/
 * rateLimit/maxDuration/maxTokens 字段。补全后增加：
 *   1. 按 provider 分组（<optgroup>）—— Kimi / DeepSeek / 火山引擎
 *   2. 选中模型详情条 —— 能力徽章 + 定价 + 积分（图像）+ 速率 + 上限
 *   3. value 不在列表时自动回退首个（防 <select> 空白）
 *   4. 空模型列表兜底（disabled + 占位 option）
 *
 * @example
 * <ModelSelector
 *   models={IMAGE_MODELS}
 *   value={imageModel}
 *   onChange={setImageModel}
 *   label="生图模型"
 * />
 */

import { useEffect, useMemo } from "react";
import {
  estimateImageGenerationCredits,
  type ModelCapability,
  type ModelOption,
} from "../../lib/models";
import { getProviderName } from "../../lib/providers";

// ============================================================
// 常量映射（capability → 中文展示）
// ============================================================

/**
 * ModelCapability → 极短中文徽章文案。
 * 用于选中模型详情条左侧的能力徽章（琥珀色品牌徽章）。
 */
const CAPABILITY_LABELS: Record<ModelCapability, string> = {
  text_generation: "文本",
  image_generation: "图像",
  video_generation: "视频",
  tts: "语音",
};

// ============================================================
// 类型定义
// ============================================================

export interface ModelSelectorProps {
  /** 可选模型列表（由父组件按阶段过滤后传入，如 LANGUAGE_MODELS / IMAGE_MODELS / VIDEO_MODELS） */
  models: ModelOption[];
  /** 当前选中模型 id（"provider/model-name"） */
  value: string;
  /** 选择回调 */
  onChange: (id: string) => void;
  /** 选择器标签文本，如「剧本模型」「生图模型」「视频模型」 */
  label: string;
  /** 是否禁用（生成进行中时常禁用，避免切换中断任务） */
  disabled?: boolean;
  /** 是否显示选中模型详情条（能力徽章 + 定价 + 速率等），默认 true */
  showDetails?: boolean;
  /** 容器额外类名 */
  className?: string;
}

// ============================================================
// 辅助：定价 / 积分 文案生成
// ============================================================

/**
 * 把模型的 pricing 字段渲染为一行短文案。
 *
 * 优先级：perImage > perSecondVideo > perSecondAudio > perRequest > token 单价。
 * 文件/视频/语音模型用「单位计价」更直观；文本模型 token 单价过小，换算为
 * 「每 1M output tokens」价格（与 DeepSeek 官网展示一致）。
 *
 * @returns 形如「¥0.22/张」「¥0.046/秒」「¥8.0/M tok」的短文案；无 pricing 返回 null
 */
function formatPricing(model: ModelOption): string | null {
  const p = model.pricing;
  if (!p) return null;

  if (p.perImage != null) return `¥${p.perImage}/张`;
  if (p.perSecondVideo != null) return `¥${p.perSecondVideo}/秒`;
  if (p.perSecondAudio != null) return `¥${p.perSecondAudio}/秒`;
  if (p.perRequest != null) return `¥${p.perRequest}/次`;

  if (p.outputPerToken != null) {
    // 每 1M tokens 价格（DeepSeek 官网同款展示）
    const perMillion = p.outputPerToken * 1_000_000;
    const formatted =
      perMillion >= 10 ? perMillion.toFixed(0) : perMillion.toFixed(1);
    return `¥${formatted}/M tok`;
  }
  return null;
}

/**
 * 计算图像模型的用户积分单价（仅图像模型有此项）。
 *
 * 调用 lib/models.ts 的 estimateImageGenerationCredits（app1 同名公式：
 * Math.ceil(perImage * 1.2 / 0.1)，相对成本加价 20%，1 积分 = 0.1 元）。
 *
 * @returns 形如「3 积分/张」；非图像模型或无 pricing 返回 null
 */
function formatCredits(model: ModelOption): string | null {
  const perImage = model.pricing?.perImage;
  if (perImage == null) return null;
  const credits = estimateImageGenerationCredits(perImage);
  return `${credits} 积分/张`;
}

// ============================================================
// 组件
// ============================================================

/**
 * 模型选择器（含详情条）
 *
 * - 按 provider 分组渲染 <optgroup>
 * - value 不在列表时自动回退到首个模型（防 UI 空白）
 * - 选中模型下方渲染详情条：能力徽章 + 定价 + 积分 + 输入类型 + 速率 + 上限
 *
 * 视觉：琥珀徽章=品牌身份（能力/积分），蓝徽章=交互语义（定价），
 * 灰文字=辅助信息（速率/上限）。与 app1 双色铁律一致。
 */
export function ModelSelector({
  models,
  value,
  onChange,
  label,
  disabled,
  showDetails = true,
  className,
}: ModelSelectorProps) {
  // 按 provider 分组（保序，与 models 数组顺序一致）
  const groups = useMemo(() => {
    const map = new Map<string, ModelOption[]>();
    for (const m of models) {
      const list = map.get(m.provider);
      if (list) {
        list.push(m);
      } else {
        map.set(m.provider, [m]);
      }
    }
    return Array.from(map.entries());
  }, [models]);

  // 当前选中的模型对象（用于详情条渲染）
  const selected = useMemo(
    () => models.find((m) => m.id === value) ?? null,
    [models, value],
  );

  // value 不在 models 列表里 → 自动回退首个（避免 <select> 显示空白）
  // 典型场景：父组件初始化时给了 DEFAULT_xxx_MODEL 但 models 数组没含此 id，
  // 或阶段切换时 value 残留了上一阶段的模型 id。
  useEffect(() => {
    if (selected || models.length === 0) return;
    onChange(models[0].id);
  }, [selected, models, onChange]);

  return (
    <div className={`flex flex-col gap-1 min-w-[200px] ${className ?? ""}`}>
      {/* 标签 + 下拉 */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--text-3)] whitespace-nowrap">
          {label}
        </span>
        <div className="relative flex-1 min-w-0">
          <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled || models.length === 0}
            className="input-base px-3 py-1.5 pr-8 rounded-lg text-xs appearance-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed w-full"
            aria-label={label}
          >
            {models.length === 0 ? (
              <option value="" disabled>
                无可用模型
              </option>
            ) : (
              groups.map(([provider, list]) => (
                <optgroup
                  key={provider}
                  label={getProviderName(provider)}
                >
                  {list.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              ))
            )}
          </select>
          {/* 下拉箭头：与 app1 同款 chevron，对齐右侧 padding */}
          <svg
            className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-3)]"
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
      </div>

      {/* 详情条：仅 showDetails 且存在选中模型时渲染 */}
      {showDetails && selected && <ModelDetails model={selected} />}
    </div>
  );
}

// ============================================================
// 子组件：选中模型详情条
// ============================================================

interface ModelDetailsProps {
  model: ModelOption;
}

/**
 * 选中模型详情条
 *
 * 单行 flex-wrap 排列，按以下顺序（缺失字段自动跳过）：
 *   1. 能力徽章 × N（琥珀品牌色，每个 ModelCapability 一枚）
 *   2. 定价徽章（蓝色交互色，formatPricing 输出）
 *   3. 积分徽章（琥珀品牌色，仅图像模型，formatCredits 输出）
 *   4. 输入类型（灰文字，"支持: text / image"）
 *   5. 速率限制（灰文字，"30 rpm / 并发 3"）
 *   6. 上限标记（灰文字，"≤ 10s" 或 "≤ 384K tok"）
 */
function ModelDetails({ model }: ModelDetailsProps) {
  const price = formatPricing(model);
  const credits = formatCredits(model);
  const rate = model.rateLimit;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--text-3)]">
      {/* 能力徽章：琥珀品牌 */}
      {model.capabilities.map((cap) => (
        <span
          key={cap}
          className="px-1.5 py-0.5 rounded bg-[var(--accent-dim)] text-[var(--accent)] font-medium"
        >
          {CAPABILITY_LABELS[cap] ?? cap}
        </span>
      ))}

      {/* 定价徽章：蓝色交互（与「可点击/触发动作」语义同色族） */}
      {price && (
        <span className="px-1.5 py-0.5 rounded bg-[var(--action-dim)] text-[var(--action)] font-medium tabular-nums">
          {price}
        </span>
      )}

      {/* 积分徽章：琥珀品牌（用户实际付出的「品牌化」代价） */}
      {credits && (
        <span className="px-1.5 py-0.5 rounded bg-[var(--accent-dim)] text-[var(--accent)] font-medium tabular-nums">
          {credits}
        </span>
      )}

      {/* 输入类型支持 */}
      {model.inputs.length > 0 && (
        <span className="text-[var(--text-3)]">
          支持: {model.inputs.join(" / ")}
        </span>
      )}

      {/* 速率限制 */}
      {rate && (
        <span className="text-[var(--text-3)] tabular-nums">
          {rate.rpm} rpm / 并发 {rate.concurrency}
        </span>
      )}

      {/* 视频最大时长 */}
      {model.maxDuration != null && (
        <span className="text-[var(--text-3)] tabular-nums">
          ≤ {model.maxDuration}s
        </span>
      )}

      {/* 文本最大 tokens（用 K 简化展示） */}
      {model.maxTokens != null && (
        <span className="text-[var(--text-3)] tabular-nums">
          ≤ {(model.maxTokens / 1024).toFixed(0)}K tok
        </span>
      )}
    </div>
  );
}
