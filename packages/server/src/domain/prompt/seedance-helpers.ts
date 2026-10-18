// ============================================================
// ③ server/domain/prompt — Seedance 镜头组提示词纯函数
// ============================================================
//
// 文件职责：
//   从 app1 src/core/ai/group-prompt.ts 顶部抽取的纯函数与常量：
//   - fmtTime / snapToValidDuration / VALID_DURATIONS：时间码与时长档位
//   - externalizeEmotion / EMOTION_CUES：抽象情绪→身体动作外化
//   - appendSeedanceMotionCalibration / SEEDANCE_MOTION_CALIBRATION：动作校准后缀
//   - validateSavedPromptAssetRefs：图片N 引用一致性校验
//   - extractBaseSceneId：场景 id 基础编号归一化
//   - MAX_REFERENCE_IMAGES/CHARACTERS/AUDIOS：参考图/角色/音频上限
//
// 全部为纯函数（无 I/O、无 DB、无 Redis、无 ffmpeg），可直接单测。
// ============================================================

/** Seedance 2.0 支持的有效时长档位（秒） */
export const VALID_DURATIONS = [4, 5, 6, 8, 10, 15] as const;

/**
 * 视频模型 → 单组最大时长（秒）映射。
 * Seedance 2.0 系列上限 15s；Seedance 2.5 系列上限 30s。
 * 未知模型保守取 15s（2.0 的上限），避免超时被 API 拒。
 */
const MAX_DURATION_BY_MODEL: Record<string, number> = {
  'ark/doubao-seedance-2-0-260128': 15,
  'ark/doubao-seedance-2-0-fast-260128': 15,
  'ark/doubao-seedance-2-0-mini-260615': 15,
  'ark/doubao-seedance-2-0-pro-260215': 15,
  'ark/doubao-seedance-2-5-260628': 30,
  'ark/seedance-1-0-pro': 15,
};

/** 查视频模型的单组最大时长（秒）；未知模型默认 15s。 */
export function maxDurationForVideoModel(modelId: string): number {
  return MAX_DURATION_BY_MODEL[modelId] ?? 15;
}

/**
 * 按 maxDuration 给出有效时长档位阶梯。
 * ≤15s（Seedance 2.0）沿用原档；>15s（如 2.5 的 30s）在原档之上按 5s 步长补齐到上限。
 * ⚠ 2.5 的精确中间档位以火山方舟控制台为准；5s 步长为保守安全默认，宁可少档不瞎编。
 */
export function durationLadderFor(maxDuration: number): readonly number[] {
  const baseMax = VALID_DURATIONS[VALID_DURATIONS.length - 1];
  if (!(maxDuration > baseMax)) return VALID_DURATIONS;
  const ladder: number[] = [...VALID_DURATIONS];
  for (let step = 20; step <= maxDuration; step += 5) {
    if (!ladder.includes(step)) ladder.push(step);
  }
  return ladder;
}

/** 视频模型参考图上限（Seedance 等 R2V 模型对参考图数量的硬性限制） */
export const MAX_REFERENCE_IMAGES = 9;

/**
 * 单组角色参考图的角色上限，用于跨镜头拆组（splitShotsByAssetLimit）与
 * prepareGroupPromptSnapshot 的动态槽位保底上限。对齐 app1（同值 4）。
 *
 * 火山官方建议参考人物 > 4 时保脸稳定性下降、易出「双胞胎/多主体」；app1 用 4
 * 作为拆组阈值结构防双胞胎（已上线验证），dramaforge 对齐取 4。
 *
 * 实际角色上限是动态的：先给环境(LOCATION)、物品(PROP)、站位图各保底 ≥1 张参考图
 * （若有声明），角色上限 = min(MAX_REFERENCE_CHARACTERS, 9 − 环境保底 − 物品保底
 * − 站位图保底)；末帧不保底（有空给、没空砍，由 provider 层 slice 兜底）。
 *
 * 单镜自身引用 >4 角色无法拆组时，由 prepare cap 截断 + provider slice 兜底，
 * 不在路由层硬阻断（对齐 charcap-fix，见 group-prompt-snapshot.ts）。
 *
 * 取舍：5+ 角色场景会被拆成更多子组（换取每组 ≤4 角色更少双胞胎），与 app1 同款。
 */
/**
 * 角色参考图上限。原 4（app1 防双胞胎拆组阈值）；2026-08-12 用户解除：
 * 多角色对峙场面（如 23 集 S3-31 六人对峙）按 4 截断会静默丢角色，
 * 与分镜设计资产对不上。上限提到 6，总参考图槽仍受 MAX_REFERENCE_IMAGES(9) 约束。
 */
export const MAX_REFERENCE_CHARACTERS = 6;

/** Seedance 2.0 reference_audio 数量上限 */
export const MAX_REFERENCE_AUDIOS = 3;

/**
 * 秒 → MM:SS.s 时间码格式（整数秒不显示小数）
 *
 * @example fmtTime(0) === '00:00'; fmtTime(65.5) === '01:05.5'; fmtTime(120) === '02:00'
 */
export function fmtTime(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const secPart = totalSec % 60;
  const s = Number.isInteger(secPart) ? secPart.toString() : secPart.toFixed(1);
  return `${String(m).padStart(2, '0')}:${s.padStart(s.includes('.') ? 4 : 2, '0')}`;
}

/**
 * 将时长向上对齐到 Seedance 有效档位，保证生成时间线不会截断末镜。
 * 分组器在 15 秒边界保留 0.05 秒浮点容差；更长的组必须先拆分。
 *
 * @example snapToValidDuration(7) === 8; snapToValidDuration(14) === 15
 */
export function snapToValidDuration(totalSec: number, ladder: readonly number[] = VALID_DURATIONS): number {
  if (!Number.isFinite(totalSec)) {
    throw new RangeError(`无效的镜头组时长: ${totalSec}`);
  }
  const validDuration = ladder.find(
    (duration) => totalSec <= duration + 1e-9,
  );
  if (validDuration !== undefined) return validDuration;

  const maxDuration = ladder[ladder.length - 1];
  if (totalSec <= maxDuration + 0.05 + 1e-9) {
    return maxDuration;
  }
  throw new RangeError(
    `镜头组总时长 ${totalSec}秒超过 Seedance ${maxDuration}秒上限`,
  );
}

/**
 * Seedance「动作自然度校准」后缀。
 *
 * 全局追加到每条发往 Seedance 的提示词末尾，校准动作尺度。
 * additive 且温和，不重写 LLM 已写的内容，只压住视频模型默认的「放大动作/夸张表情」倾向。
 */
export const SEEDANCE_MOTION_CALIBRATION =
  '【动作校准】动作情节必须丰富细腻：完整展现过程性动作（起身、转身、伸手、拿起、放下、注视、回应）的连贯细节，角色互动有来有回，避免简化成静止摆拍或只做单一动作；' +
  '组内镜头按因果与时间顺序连续推进：后一镜承接前一镜的动作结果、情绪与空间位置，动作不跳变、不重演、不矛盾；角色情绪变化有过程（由事件触发、逐步过渡），表情与动作和当下事件及对白内容呼应；' +
  '动作从明确起点连续完成到落点，速度和幅度符合角色用力与物体重量；' +
  '脚掌、手掌与接触面保持受力关系，重心随动作自然转移；' +
  '表情通过一个细微动作渐变呈现，脸部克制自然，不要出现过于夸张的表情（如大幅度张嘴、瞪眼、五官扭曲或夸张笑脸）。' +
  '人物眼睛保持自然（正常瞳孔与高光），眼睛不得发光、无异常光斑或能量泛光，除非分镜明确写了魔法瞳光。';

/**
 * Seedance「创作语境声明」——降低文本审核（InputTextSensitiveContentDetected）误判。
 *
 * 火山 Seedance 2.0 的内容过滤是「整段场景理解」（非逐词扫描）：像导演写镜头、有明确
 * 制作语境的提示词容错更高（官方指南 + 社区实测）。本段三点（供 seedance-narrative-rewrite
 * 的 LLM system prompt 使用，让重写后的 prompt 自然内化这些规则，而非 additive 塞进 prompt）：
 *   1. 明确「虚构影视/动漫创作 + 原创虚构形象 + 与真实人物无关」→ 帮过滤器把整段识别为创作内容；
 *   2. 声明「出场角色均为成年人」→ 规避 child/young/boy/girl 类词触发的「整段提高审查强度」；
 *   3. 补影视制作术语（景别/机位/光源/剪辑）→ 建立制作语境，进一步抬高容错。
 *
 * ⚠ 只对【文本审核】有效。图片侧的真人检测（InputImageSensitiveContentDetected.PrivacyInformation）
 * 发生在读取文本之前，声明救不回——那必须靠画风（2d_anime 插画，非 realistic 真人写实）
 * + 参考图 100 格网格干扰（见 client/ffmpeg/grid-overlay）。
 */
export const SEEDANCE_CREATION_CONTEXT =
  '【创作语境与镜头规范】本片为虚构影视/动漫创作，所有出场角色均为原创虚构形象，与任何真实人物、事件、组织无关；出场角色均为成年人。' +
  '依据火山《Seedance 2.0 提示词指南》，请严格遵循以下镜头描述规范：' +
  '1. 只写镜头能拍到的「可见事实」——场景、动作、光影、构图、机位；不写动机、背景故事、内心独白等潜台词（潜台词留在创作意图中，不写进提示词）。' +
  '2. 每个镜头齐备「地点 + 视觉氛围 + 镜头类型 + 整体氛围」，像导演的 shot list，给审核器完整可读的电影化语境，避免描述过于稀疏被保守误判。' +
  '3. 按「场景角色」而非「年龄」指代人物：避免 child/kid/young/boy/girl/小孩/少年等指向低龄的词（会触发更严格审查并波及整段），人物身份与年龄交由参考图承担。' +
  '4. 暴力/冲突/危险情节用电影化安全措辞，不渲染血腥/色情/政治敏感细节（如：交锋、对峙、负伤、倒地，而非流血、死亡、杀戮）。' +
  '5. 用影视制作术语建立制作语境（景别：大远景/远景/全景/中景/近景/特写；运镜：推拉摇移/跟拍/固定；光源：侧逆光/漫射；色调：低饱和/冷暖；画幅：35mm/变形宽幕），制作语境可显著抬高审核容错。' +
  '6. 剔除空洞的质量与分辨率 booster（8K、4K、超高清、杰作、绝美、史诗级、电影感、氛围感、高级感、质感、震撼等无法被镜头拍到的词）；若需要其效果，用具体的景别+运镜+光源+调色替代，如「电影感」改写为「宽幅远景、缓慢推镜、低角度暖阳、低饱和青橙调」。';

/**
 * 情绪→身体动作外化映射（火山官方《Seedance 2.0 提示词指南》第3节）。
 * 官方要求用具体的身体细节表现情绪，替代「很悲伤」「非常愤怒」这类抽象词。
 */
export const EMOTION_CUES: { keywords: string[]; cues: string }[] = [
  { keywords: ['悲伤', '哀伤', '伤心', '难过', '心碎', '忧伤', '沉痛', '凄', '失落', '沮丧'], cues: '低头、肩膀微微颤抖、眼眶泛红、手指攥紧衣角' },
  { keywords: ['喜悦', '开心', '高兴', '快乐', '欢喜', '欣喜', '雀跃', '兴奋'], cues: '嘴角上扬、眉眼舒展、脚步轻快' },
  { keywords: ['紧张', '焦虑', '不安', '慌张', '惊慌', '忐忑', '惶', '忐忑不安'], cues: '呼吸急促、眼神闪躲、手指无意识敲击' },
  { keywords: ['愤怒', '生气', '恼怒', '暴怒', '气愤', '怒'], cues: '双拳紧握、下颌线紧绷、胸口起伏' },
  { keywords: ['释然', '放松', '松一口气', '宽慰', '平静下来', '如释重负'], cues: '长舒一口气、紧绷的肩膀放松、淡淡微笑' },
];

/** 身体动作线索词——原文已含此类词时认为情绪已被具象表达，不再重复注入。 */
const PHYSICAL_CUE_WORDS = [
  '低头', '颤抖', '攥紧', '嘴角', '上扬', '呼吸', '闪躲', '紧握', '下颌', '胸口', '舒了一', '微笑', '攥', '轻快', '叹息',
];

/**
 * 把镜头文本中的抽象情绪外化为身体动作线索（官方指南第3节）。
 *
 * 命中任一情绪关键词且原文未含具体身体动作线索时，返回外化后的线索串；否则返回 null。
 *
 * @example externalizeEmotion('她很悲伤') → '低头、肩膀微微颤抖、眼眶泛红、手指攥紧衣角'
 * @example externalizeEmotion('她低头哭泣') → null（已含身体动作「低头」）
 * @example externalizeEmotion('她走着') → null（无情绪关键词）
 */
export function externalizeEmotion(text: string): string | null {
  if (!text) return null;
  const hits: string[] = [];
  for (const e of EMOTION_CUES) {
    if (e.keywords.some((k) => text.includes(k))) hits.push(e.cues);
  }
  if (hits.length === 0) return null;
  // 原文已含具体身体动作线索时不再重复注入
  if (PHYSICAL_CUE_WORDS.some((c) => text.includes(c))) return null;
  return hits.join('；');
}

/** 将动作自然度校准后缀追加到 Seedance 提示词末尾（幂等：已含则不重复追加）。 */
export function appendSeedanceMotionCalibration(prompt: string): string {
  if (!prompt) return prompt;
  return prompt.includes(SEEDANCE_MOTION_CALIBRATION)
    ? prompt
    : `${prompt}\n\n${SEEDANCE_MOTION_CALIBRATION}`;
}

/**
 * 提取场景 id 的基础编号（"S1-1" → "S1"；"S1" → "S1"）。
 *
 * 分镜生成阶段会把场景 id 改写为 `${scene.id}-${i+1}`（如 "S1-1"），
 * 归一化后才能正确匹配镜头所属场景与造型表。
 */
export function extractBaseSceneId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const m = value.trim().match(/^(S\d+)/i);
  return m ? m[1].toUpperCase() : value.trim();
}

/** 资产引用条目（用于 validateSavedPromptAssetRefs） */
export interface AssetRef {
  name: string;
  kind: 'CHARACTER' | 'LOCATION' | 'PROP';
}

/**
 * 校验已保存的组提示词中 图片N 引用是否与当前 assetRefs 一致。
 *
 * 用途：savedGroupPrompt（用户保存的旧提示词）可能采用已废弃的 @{name} 格式，
 * 或 图片N 索引范围与当前 assetRefs 数量不一致，都会导致模型按错误索引对应参考图。
 *
 * @returns true 表示索引一致，可安全使用 savedPrompt；false 表示不一致，应回退重生成
 */
export function validateSavedPromptAssetRefs(
  savedPrompt: string,
  assetRefs: AssetRef[],
): boolean {
  if (!savedPrompt || !assetRefs || assetRefs.length === 0) return true;
  // 1. 检测旧格式 @{...}：任何残留都强制重生成
  if (/@\{[^}]*\}/.test(savedPrompt)) return false;
  // 2. 提取 图片N 索引（兼容历史 "@图片 1" 带空格写法）
  const indices = [...savedPrompt.matchAll(/@?图片\s*(\d+)/g)].map((m) =>
    parseInt(m[1], 10),
  );
  if (indices.length === 0) return false; // 新格式必须有 图片N 引用
  const M = assetRefs.length;
  const indexSet = new Set(indices);
  // 3. 校验：恰好覆盖 1..M，无重复、无越界
  if (indexSet.size !== M) return false;
  for (let n = 1; n <= M; n++) {
    if (!indexSet.has(n)) return false;
  }
  return true;
}
