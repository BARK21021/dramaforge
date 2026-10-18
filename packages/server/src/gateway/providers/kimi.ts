// ============================================================
// ② server/gateway/providers — Kimi / Moonshot
// ============================================================
// 文本：移植自 app1 callKimi。POST {baseUrl}/chat/completions Bearer，
//   OpenAI 兼容（callOpenAICompatibleTextGen）。Kimi 已弃用 max_tokens，
//   用 max_completion_tokens（_shared 已处理）。
//
// 视频理解（转绘 X1）：移植自 app1 core/video/kimi-client.ts。
//   - video_understanding：长视频分段分析（uploadAndPrepareVideo + analyzeVideoSegment，
//     连续性锚点剧情事实稿 prompt）。/api/generate/text 用。
//   - video_to_script（转绘 X2）：单集视频转剧本（extractVideoContext + generateScriptFromVideo，
//     Kimi-only，砍 Whisper/OCR）。episode 级 video-to-script route 用。
//   凭证从 callAI 的 cred 直传（key 只在 server，GC-1）。新链路把 route 的 Web Stream
//   按背压接力给 Kimi Files API；Buffer 只兼容旧调用，全程不落服务器磁盘。
// ============================================================

import type { GatewayPayload, GatewayResult, ProviderCredential } from '../types';
import {
  callOpenAICompatibleTextGenStream,
  extractModelId,
} from './_shared';
import { safeParseJsonObject } from '../../domain/prompt/json-repair';
import { query } from '@server/infra';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

// ---------------- 视频理解常量（移植 app1 kimi-client.ts）----------------

/** Chat Completion 最大输出 tokens（kimi-k2.6 上限）。Moonshot 用 max_completion_tokens。 */
const KIMI_MAX_OUTPUT_TOKENS = 262144;
/** 文件上传基础超时；大文件按保守上行带宽自动放宽。 */
const UPLOAD_BASE_TIMEOUT_MS = 120_000;
const UPLOAD_MAX_TIMEOUT_MS = 15 * 60_000;
/** Chat 总超时（视频理解冷启动首 chunk 可能 >60s）。 */
const CHAT_TOTAL_TIMEOUT_MS = 600_000;
/** Chat idle 超时（两个 chunk 之间最大间隔）。 */
const CHAT_IDLE_TIMEOUT_MS = 120_000;
const KIMI_MAX_ATTEMPTS = 5;

/** 按 256 KiB/s 保守带宽估算上传超时，额外预留 60s 服务端处理。 */
function resolveKimiUploadTimeoutMs(fileBytes: number): number {
  if (!Number.isFinite(fileBytes) || fileBytes <= 0) return UPLOAD_BASE_TIMEOUT_MS;
  return Math.min(
    UPLOAD_MAX_TIMEOUT_MS,
    Math.max(UPLOAD_BASE_TIMEOUT_MS, Math.ceil(fileBytes / (256 * 1024)) * 1000 + 60_000),
  );
}

class KimiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'KimiRequestError';
  }
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function isTransientKimiError(error: unknown): boolean {
  if (error instanceof KimiRequestError) {
    return [429, 500, 502, 503, 504].includes(error.status);
  }
  return (
    error instanceof Error && ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name)
  );
}

function summarizeKimiError(error: unknown): string {
  if (error instanceof KimiRequestError) {
    const retryAfter =
      error.retryAfterMs !== undefined ? `, retry-after=${error.retryAfterMs}ms` : '';
    return `HTTP ${error.status}${retryAfter}: ${error.message}`.slice(0, 1200);
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 1200);
  return String(error).slice(0, 1200);
}

async function withKimiRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= KIMI_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientKimiError(error) || attempt === KIMI_MAX_ATTEMPTS) {
        console.warn(
          `[kimi] ${label} 失败 (${attempt}/${KIMI_MAX_ATTEMPTS}): ${summarizeKimiError(error)}`,
        );
        throw error;
      }
      const serverDelay = error instanceof KimiRequestError ? error.retryAfterMs : undefined;
      const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 750);
      const delay = Math.max(serverDelay ?? 0, backoff + jitter);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// ---------------- 视频上传（purpose=video，同步就绪）----------------

interface UploadedVideo {
  fileId: string;
  fileReference: string;
}

/** 视频转剧本只向上层暴露离散阶段，不暴露正文、媒体字节或凭证。 */
type VideoToScriptStage =
  | 'file_received'
  | 'extracting_context'
  | 'context_extracted'
  | 'generating_script'
  | 'script_generated';

/**
 * 上报真实 provider 边界。进度观测失败不能让已经上传的视频和模型调用一并失败，
 * 因此回调错误只记无敏感信息的 warning。
 */
async function emitVideoToScriptStage(
  input: Record<string, unknown>,
  stage: VideoToScriptStage,
): Promise<void> {
  const callback = input.onProgress;
  if (typeof callback !== 'function') return;
  try {
    await (callback as (event: { stage: VideoToScriptStage }) => void | Promise<void>)({ stage });
  } catch (error) {
    console.warn('[kimi] 视频转剧本进度上报失败', {
      stage,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Kimi 上传源：新链路使用 Web Stream，旧链路继续接受 Buffer。 */
type VideoUploadSource = Buffer | ReadableStream<Uint8Array>;

/** 判断网关 input 中的未知值是否为可消费的 Web ReadableStream。 */
function isVideoStream(value: unknown): value is ReadableStream<Uint8Array> {
  return Boolean(value && typeof value === 'object'
    && typeof (value as ReadableStream<Uint8Array>).getReader === 'function');
}

/**
 * 组装 Kimi Files API 的 multipart 流。
 * 手工写边界可避免 FormData 把大视频复制成 Blob；Readable.from 会按上游背压取数据。
 */
function createKimiMultipartBody(
  source: VideoUploadSource,
  fileBytes: number,
  filename: string,
  mimeType: string,
): { body: Readable; contentType: string; contentLength: number } {
  const boundary = `----dramaforge-${randomUUID()}`;
  const safeMime = /^video\/[a-z0-9.+-]+$/i.test(mimeType) ? mimeType : 'video/mp4';
  // ⚠️ multipart 头里绝不能带原始（含中文/全角）文件名：Moonshot /files 对
  // `filename*=UTF-8''<百分号编码多字节>` 的解析会 400 "http: no such file"，
  // 直接丢弃整个 file part（已用真实 key 复现：ASCII 名→文件能收到并进处理，
  // 中文 %XX→file part 丢失 → 单集视频转剧本整条 502）。Kimi 后续按 ms://fileId
  // 引用文件、不依赖文件名；真实 MIME 由 Content-Type 承载，故固定 ASCII 名即可。
  // filename 参数仍保留，仅用于上传失败时的重试/日志标签。
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nvideo\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="video.mp4"\r\n`
      + `Content-Type: ${safeMime}\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);

  async function* parts(): AsyncGenerator<Uint8Array> {
    yield prefix;
    if (Buffer.isBuffer(source)) {
      yield source;
    } else {
      const reader = source.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.byteLength > 0) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    }
    yield suffix;
  }

  return {
    body: Readable.from(parts()),
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: prefix.byteLength + fileBytes + suffix.byteLength,
  };
}

async function uploadVideoFile(
  cred: ProviderCredential,
  source: VideoUploadSource,
  fileBytes: number,
  filename: string,
  mimeType: string,
): Promise<UploadedVideo> {
  const baseUrl = cred.baseUrl || 'https://api.moonshot.cn/v1';
  const upload = async () => {
    const multipart = createKimiMultipartBody(source, fileBytes, filename, mimeType);
    const uploadTimeoutMs = resolveKimiUploadTimeoutMs(fileBytes);
    const requestInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cred.apiKey}`,
        'Content-Type': multipart.contentType,
        'Content-Length': String(multipart.contentLength),
      },
      body: multipart.body,
      // Node fetch 的流式 request body 必须启用 half duplex；响应仍可正常流式读取。
      duplex: 'half',
      signal: AbortSignal.timeout(uploadTimeoutMs),
    };
    // DOM 的 RequestInit 类型尚未声明 Node fetch 支持的 Readable/duplex，运行时由 undici 原生支持。
    const resp = await fetch(`${baseUrl}/files`, requestInit as unknown as RequestInit);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new KimiRequestError(
        `Kimi 文件上传失败 (${resp.status}): ${errText}`,
        resp.status,
        retryAfterMs(resp),
      );
    }
    return resp.json() as Promise<{ id: string; filename?: string; status?: string }>;
  };
  // Web Stream 是一次性源，失败后交给客户端重试；Buffer 兼容链路仍保留原 5 次退避。
  const data = isVideoStream(source) ? await upload() : await withKimiRetry(upload, `上传 ${filename}`);
  if (!data.id) throw new Error('Kimi 文件上传成功但未返回 file_id');
  // 粘性 key 锁：记录该 fileId 归属哪个 api_config（账号），后续复用时锁回原 key，
  // 防多 key 轮转 403（文件归账号 A，跨 key 访问 → 「不是文件所有者」）。
  // 仅池 key（cred.configId 存在）时记录；env 单 key 无轮转无需。fire-and-forget，不阻塞。
  if (cred.configId) {
    query(
      `INSERT INTO provider_files (file_id, provider, api_config_id) VALUES ($1, 'kimi', $2)
       ON CONFLICT (file_id) DO NOTHING`,
      [data.id, cred.configId],
    ).catch(() => {});
  }
  return { fileId: data.id, fileReference: `ms://${data.id}` };
}

// ---------------- SSE 流式 chat 公共核心 ----------------

/** Kimi chat 单次调用的 token 用量，供 pricing.ts 成本归因（对齐 meta.tokensUsed 契约）。 */
interface KimiTokenUsage {
  input: number;
  output: number;
  cacheHit: number;
  cacheMiss: number;
}

const EMPTY_KIMI_USAGE: KimiTokenUsage = { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 };

/**
 * 累加多次 chat 的 token 用量（video_to_script 调 2 次 chat：extract + generate）。
 * input/output 直接累加；缓存命中/未命中各自累加，由 pricing.readTokenUsage 统一兜底校验。
 */
function accumulateUsage(acc: KimiTokenUsage, add: KimiTokenUsage): KimiTokenUsage {
  return {
    input: acc.input + add.input,
    output: acc.output + add.output,
    cacheHit: acc.cacheHit + add.cacheHit,
    cacheMiss: acc.cacheMiss + add.cacheMiss,
  };
}

/**
 * Kimi SSE 流式 chat（600s 总超时 + 120s idle + 5 次退避重试）。
 * 移植自 app1 streamChatCompletion，抽成公共函数供三类视频 prompt 复用：
 * 长视频分段分析 / 单集角色提取 / 单集剧本生成。
 *
 * 必须传 stream_options.include_usage=true：Moonshot/OpenAI 兼容 SSE 默认不在流中带
 * usage，不加此参数则 token 永远为 0 → video_understanding/video_to_script 漏扣（P0-3）。
 * usage 通常只在 [DONE] 前最后一个 chunk 出现，故每行都尝试解析（与 _shared 流式实现一致）。
 */
async function kimiStreamChat(
  cred: ProviderCredential,
  model: string,
  messages: Array<Record<string, unknown>>,
  options: { disableThinking?: boolean; maxCompletionTokens?: number; label?: string } = {},
): Promise<{ text: string; usage: KimiTokenUsage }> {
  const baseUrl = cred.baseUrl || 'https://api.moonshot.cn/v1';
  const maxTokens = options.maxCompletionTokens ?? KIMI_MAX_OUTPUT_TOKENS;
  return withKimiRetry(async () => {
    const controller = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(), CHAT_TOTAL_TIMEOUT_MS);
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), CHAT_IDLE_TIMEOUT_MS);
    };
    try {
      resetIdleTimer();
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cred.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          // 不带 include_usage 则 SSE 不返 usage → 计费归因拿到 0 → 长期免费烧钱（P0-3）。
          stream_options: { include_usage: true },
          max_completion_tokens: maxTokens,
          ...(options.disableThinking ? { thinking: { type: 'disabled' } } : {}),
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new KimiRequestError(
          `Kimi Chat API 返回 ${resp.status}: ${errText}`,
          resp.status,
          retryAfterMs(resp),
        );
      }
      if (!resp.body) throw new Error('Kimi Chat API 未返回响应体');
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';
      const usage: KimiTokenUsage = { ...EMPTY_KIMI_USAGE };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdleTimer();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                prompt_cache_hit_tokens?: number;
                prompt_cache_miss_tokens?: number;
              } | null;
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) fullText += delta;
            // usage 一般只在末段出现；解析到即覆盖零值（同一响应不会重复发不同 usage）。
            if (parsed.usage) {
              usage.input = Math.max(usage.input, Number(parsed.usage.prompt_tokens) || 0);
              usage.output = Math.max(usage.output, Number(parsed.usage.completion_tokens) || 0);
              usage.cacheHit = Number(parsed.usage.prompt_cache_hit_tokens) || 0;
              usage.cacheMiss = Number(parsed.usage.prompt_cache_miss_tokens) || 0;
            }
          } catch {
            // 单行解析失败，跳过
          }
        }
      }
      return { text: fullText, usage };
    } finally {
      clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
    }
  }, options.label ?? `模型 ${model} 视频 chat`);
}

// ---------------- 长视频分段分析（video_understanding，X1）----------------

/**
 * 独立分析一个长视频片段，输出含时间锚点 + 连续性锚点的剧情事实稿，供后续按序拼接。
 * prompt 移植自 app1 analyzeVideoSegment（OCR/Whisper 不参与本链路）。
 */
async function analyzeVideoSegmentStream(
  cred: ProviderCredential,
  model: string,
  fileReference: string,
  input: { segmentIndex: number; segmentCount: number; startSec: number; endSec: number },
): Promise<{ text: string; usage: KimiTokenUsage }> {
  const systemPrompt = `你是专业影视剧情还原分析师。只分析当前视频片段，输出可供后续全剧拼接的紧凑、高保真剧情事实稿。

硬性规则：
1. 自动识别并彻底剔除广告、品牌口播、商品卡/二维码引导、平台片头片尾、无关花絮、重复回顾和纯黑空白；只在"剔除记录"里写时间段与类型，不得写进剧情。
2. 严格按时间顺序记录每个有效场景；保留人物可见动作、关系变化、关键道具、对白/旁白大意和情绪转折，不凭空补写本片段未呈现的结局。
3. 不确定的人名先用稳定临时名（角色A/角色B），并写清外貌、服装、身份线索；不要在同一片段内改名。
4. 片段开头和结尾分别输出连续性锚点：地点、在场人物、姿态、道具状态、正在进行的动作、已知秘密和未完成事件。
5. 用绝对时间码 HH:MM:SS.mmm（当前片段相对全片的起点已提供），避免相邻片段拼接时重复或漏记。
6. 不输出营销评价、分析过程或泛泛总结。
7. 推动因果、揭示身份或改变关系的关键台词必须完整保留；不得为追求简短而压缩、跳过或合并剧情。
8. 不设置字数上限。完整性优先，必须覆盖全部有效场景、转折、死亡、身份揭露、关键道具转移和片尾未完成事件。

输出结构：
# 片段信息
# 剔除记录
# 开头连续性锚点
# 逐场剧本
# 本段新增事实
# 结尾连续性锚点`;
  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'video_url', video_url: { url: fileReference } },
        {
          type: 'text',
          text: `这是全片第 ${input.segmentIndex + 1}/${input.segmentCount} 段，绝对时间范围 ${input.startSec.toFixed(3)}s-${input.endSec.toFixed(3)}s。请按规定还原有效剧情。`,
        },
      ],
    },
  ];
  // 官方 K2.6 支持关闭思考；视频事实提取无需长推理，显著缩短首 token 与总耗时。
  // 透传 token 用量供 callKimi 写入 meta.tokensUsed（pricing 成本归因依赖）。
  return kimiStreamChat(cred, model, messages, {
    disableThinking: true,
    label: `模型 ${model} 视频分析`,
  });
}

// ---------------- 单集视频转剧本（video_to_script，X2）----------------

interface CharacterInfo {
  name: string;
  description: string;
}

/**
 * 单集视频第 1 次 Kimi chat：结构化抽取角色/场景/时代（移植 app1 extractVideoContext）。
 * prompt 要求只返回 JSON；safeParseJsonObject 兜底解析，失败返回空角色/场景。
 */
async function extractVideoContextStream(
  cred: ProviderCredential,
  model: string,
  fileReference: string,
): Promise<{ characters: CharacterInfo[]; locations: string[]; timePeriod?: string; usage: KimiTokenUsage }> {
  const systemPrompt = `你是一个专业的视频内容分析师。请分析视频内容，提取以下信息并以 JSON 格式返回：
{
  "characters": [
    { "name": "角色名", "description": "角色外貌、身份、造型描述" }
  ],
  "locations": ["场景1", "场景2"],
  "timePeriod": "时代背景（如现代、古代、民国等）"
}

要求：
1. 角色名用视频中出现的称呼或自行命名
2. 场景为视频中出现的地点
3. 只返回 JSON，不要其他文本`;
  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'video_url', video_url: { url: fileReference } },
        { type: 'text', text: '请分析这段视频，提取角色、场景和时代信息。' },
      ],
    },
  ];
  const { text, usage } = await kimiStreamChat(cred, model, messages, {
    label: `模型 ${model} 视频角色提取`,
  });
  const parsed = safeParseJsonObject(text);
  if (!parsed) return { characters: [], locations: [], usage };
  const characters: CharacterInfo[] = Array.isArray(parsed.characters)
    ? parsed.characters
        .map((c: { name?: unknown; description?: unknown }) => ({
          name: String(c?.name ?? ''),
          description: String(c?.description ?? ''),
        }))
        .filter((c: CharacterInfo) => c.name)
    : [];
  const locations: string[] = Array.isArray(parsed.locations)
    ? parsed.locations.map((l: unknown) => String(l)).filter(Boolean)
    : [];
  const timePeriod =
    typeof parsed.timePeriod === 'string' && parsed.timePeriod.trim()
      ? parsed.timePeriod.trim()
      : undefined;
  return { characters, locations, timePeriod, usage };
}

/**
 * 单集视频第 2 次 Kimi chat：基于视频 + 已抽取角色/场景/时代生成结构化剧本
 * （移植 app1 generateScriptFromVideo）。X2 Kimi-only：砍 Whisper/OCR，
 * transcriptionText/ocrText 留空，auxSection 不拼接（prompt 仍含角色/场景/时代 + 视频本体）。
 */
async function generateScriptFromVideoStream(
  cred: ProviderCredential,
  model: string,
  fileReference: string,
  ctx: { characters: CharacterInfo[]; locations: string[]; timePeriod?: string },
): Promise<{ text: string; usage: KimiTokenUsage }> {
  const charList = ctx.characters.map((c) => `- ${c.name}: ${c.description}`).join('\n');
  const locList = ctx.locations.join('、');
  const systemPrompt = `你是一个专业的影视编剧。请基于视频内容生成结构化的剧本。

已知信息：
- 角色：
${charList || '（待分析）'}
- 场景：${locList || '（待分析）'}
- 时代背景：${ctx.timePeriod || '（待分析）'}

请生成包含以下内容的剧本：
1. 场景描述（Scene List）
2. 信息要点（Info Points）
3. 服装设定表（Costume Table）
4. 对白和动作描述

要求：
1. 剧本语言与视频语言一致
2. 角色名使用上述已知角色名
3. 场景使用上述已知场景
4. 对白自然流畅，符合角色性格
5. 场景描述详细，包含视觉、听觉元素`;
  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'video_url', video_url: { url: fileReference } },
        { type: 'text', text: '请基于这段视频生成完整的剧本。' },
      ],
    },
  ];
  // 透传 token 用量供 callKimi 写入 meta.tokensUsed（与 extract 累加，pricing 归因）。
  return kimiStreamChat(cred, model, messages, {
    label: `模型 ${model} 视频剧本生成`,
  });
}

// ---------------- callKimi 入口 ----------------

export async function callKimi(
  model: string,
  payload: GatewayPayload,
  cred: ProviderCredential,
): Promise<GatewayResult> {
  const modelId = extractModelId(model);
  const baseUrl = cred.baseUrl || 'https://api.moonshot.cn/v1';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cred.apiKey}`,
  };

  if (payload.capability === 'text_generation') {
    // Moonshot K2.6/K3 只接受 temperature=1（实测 K2.6 对 0.2 返回
    // "invalid temperature: only 1 is allowed for this model"）。
    // 上游资产提取等链路按 DeepSeek 习惯传 0.2，这里必须显式钳制，
    // 不能只靠 defaultTemp（input.temperature 优先于 defaultTemp）。
    // 走 SSE 流式：K2.6/K3 是推理模型，非流式长 JSON 在 Moonshot 侧约 5
    // 分钟会被断连（实测 "fetch failed"），流式总时限 15 分钟 + 3 分钟
    // idle 保活（对齐 DeepSeek 整剧提取的既有通道）。
    const input = { ...payload.input, temperature: 1 };
    return callOpenAICompatibleTextGenStream(modelId, { ...cred, baseUrl }, headers, input, {
      defaultTemp: 1,
    });
  }

  if (payload.capability === 'video_understanding') {
    const input = payload.input;
    const videoBytes = input.videoBytes;
    const videoStream = input.videoStream;
    const videoSize = Number(input.videoSize);
    const reuseFileId = typeof input.fileId === 'string' ? input.fileId : undefined;
    // 复用已上传文件：cred 已被 callAI 按 pinnedFileId 锁回上传该文件的原 key（防多 key 轮转 403）。
    let fileReference: string;
    let fileId: string;
    if (reuseFileId && !Buffer.isBuffer(videoBytes) && !isVideoStream(videoStream)) {
      fileId = reuseFileId;
      fileReference = `ms://${reuseFileId}`;
    } else {
      const source = Buffer.isBuffer(videoBytes) ? videoBytes : videoStream;
      if (!Buffer.isBuffer(source) && !isVideoStream(source)) {
        throw new Error('Kimi video_understanding 需要 input.videoBytes 或 input.videoStream');
      }
      const sourceSize = Buffer.isBuffer(source) ? source.byteLength : videoSize;
      if (!Number.isFinite(sourceSize) || sourceSize <= 0) {
        throw new Error('Kimi 视频流缺少有效 videoSize');
      }
      const filename = String(input.filename ?? 'segment.mp4');
      const mimeType = String(input.mimeType ?? 'video/mp4');
      const uploaded = await uploadVideoFile(cred, source, sourceSize, filename, mimeType);
      fileId = uploaded.fileId;
      fileReference = uploaded.fileReference;
    }
    const { text: content, usage } = await analyzeVideoSegmentStream(cred, modelId, fileReference, {
      segmentIndex: Number(input.segmentIndex ?? 0),
      segmentCount: Number(input.segmentCount ?? 1),
      startSec: Number(input.startSec ?? 0),
      endSec: Number(input.endSec ?? 0),
    });
    // token 用量供 callAI 成本归因（pricing.computeTokenCostYuan）；缺失则归因为 0。
    return { url: '', meta: { content, fileId, tokensUsed: usage } };
  }

  if (payload.capability === 'video_to_script') {
    const input = payload.input;
    const videoBytes = input.videoBytes;
    const videoStream = input.videoStream;
    const videoSize = Number(input.videoSize);
    const reuseFileId = typeof input.fileId === 'string' ? input.fileId : undefined;
    let fileReference: string;
    let fileId: string;
    if (reuseFileId && !Buffer.isBuffer(videoBytes) && !isVideoStream(videoStream)) {
      fileId = reuseFileId;
      fileReference = `ms://${reuseFileId}`;
    } else {
      const source = Buffer.isBuffer(videoBytes) ? videoBytes : videoStream;
      if (!Buffer.isBuffer(source) && !isVideoStream(source)) {
        throw new Error('Kimi video_to_script 需要 input.videoBytes 或 input.videoStream');
      }
      const sourceSize = Buffer.isBuffer(source) ? source.byteLength : videoSize;
      if (!Number.isFinite(sourceSize) || sourceSize <= 0) {
        throw new Error('Kimi 视频流缺少有效 videoSize');
      }
      const filename = String(input.filename ?? 'video.mp4');
      const mimeType = String(input.mimeType ?? 'video/mp4');
      const uploaded = await uploadVideoFile(cred, source, sourceSize, filename, mimeType);
      fileId = uploaded.fileId;
      fileReference = uploaded.fileReference;
    }
    await emitVideoToScriptStage(input, 'file_received');
    await emitVideoToScriptStage(input, 'extracting_context');
    const ctx = await extractVideoContextStream(cred, modelId, fileReference);
    await emitVideoToScriptStage(input, 'context_extracted');
    await emitVideoToScriptStage(input, 'generating_script');
    const { text: script, usage: genUsage } = await generateScriptFromVideoStream(
      cred,
      modelId,
      fileReference,
      ctx,
    );
    await emitVideoToScriptStage(input, 'script_generated');
    // 两次 chat（extract + generate）token 累加，供 callAI 成本归因。
    const tokensUsed = accumulateUsage(ctx.usage, genUsage);
    return {
      url: '',
      meta: {
        script,
        characters: ctx.characters,
        locations: ctx.locations,
        timePeriod: ctx.timePeriod,
        fileId,
        tokensUsed,
      },
    };
  }

  throw new Error(`Kimi 不支持的能力: ${payload.capability}`);
}
