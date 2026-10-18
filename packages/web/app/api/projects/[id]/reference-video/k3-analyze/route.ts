// ============================================================
// POST /api/projects/[id]/reference-video/k3-analyze
// ============================================================

import type { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import {
  projectRepo,
  episodeRepo,
  getCredential,
  callAI,
  listAssets,
  startInlineAiTask,
  reportInlineAiTaskProgress,
  completeInlineAiTask,
  failInlineAiTask,
} from '@dramaforge/server';
import { parseModel } from '@web/lib/model-parser';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import { billDirectGeneration } from '@web/lib/direct-media-generation';

const DEFAULT_MODEL = 'kimi-k3';
const DEFAULT_CHARACTERS = 'ML1=黑西装红领带男(CEO), FL1=白婚纱新娘, FS1/FS2=粉色裙伴娘, ML2=燕尾服新郎, FS3=黑马甲白衬衫接待员';
const MAX_FILE_SIZE = 1024 * 1024 * 1024;

export interface K3Shot {
  index: number;
  startTime: number;
  endTime: number;
  shotType: string;
  cameraAngle: string;
  characters: string[];
  action: string;
  emotion: string;
  dialogue: string;
  setting: string;
  location: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId } = await params;
    const project = await projectRepo.getById(projectId);
    if (!project) return apiFail({ error: '项目不存在', code: 'NOT_FOUND' }, 404);
    if (project.userId !== auth.userId) {
      return apiFail({ error: '无权访问此项目', code: 'FORBIDDEN' }, 403);
    }

    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;

    const formData = await req.formData();
    const file = formData.get('video') as File | null;
    if (!file) return apiFail({ error: '未提供视频文件', code: 'NO_FILE' }, 400);
    if (file.size > MAX_FILE_SIZE) {
      return apiFail({ error: '视频过大，最大支持 1GB', code: 'FILE_TOO_LARGE' }, 400);
    }

    const characterDefs = (formData.get('characters') as string) || DEFAULT_CHARACTERS;
    const rawModel = (formData.get('model') as string) || DEFAULT_MODEL;
    const model = rawModel.startsWith('kimi/') ? rawModel.slice(5) : rawModel;
    const targetLanguage = (formData.get('targetLanguage') as string) || '';
    const episodeNumber = Number(formData.get('episodeNumber') || 1);
    const episodeIdParam = (formData.get('episodeId') as string) || '';

    const cred = await getCredential('kimi', auth.userId);
    const baseUrl = cred.baseUrl || 'https://api.moonshot.cn/v1';
    const videoBuf = Buffer.from(await file.arrayBuffer());

    const taskId = randomUUID();
    await startInlineAiTask({
      id: taskId,
      userId: auth.userId,
      projectId,
      type: 'VIDEO_TO_SCRIPT_FULL',
      progress: 5,
      stage: '正在分析视频',
      storedInput: { episodeId: episodeIdParam, projectId },
    });

    void runK3Analysis({
      taskId,
      userId: auth.userId,
      projectId,
      episodeIdParam,
      episodeNumber,
      model,
      targetLanguage,
      characterDefs,
      baseUrl,
      apiKey: cred.apiKey,
      videoBuf,
    }).catch((err) => {
      console.error('[k3-analyze] runner error', err);
    });

    return apiSuccess({ taskId }, 202);
  } catch (err) {
    return handleApiError(err);
  }
}

async function runK3Analysis(input: {
  taskId: string;
  userId: string;
  projectId: string;
  episodeIdParam: string;
  episodeNumber: number;
  model: string;
  targetLanguage: string;
  characterDefs: string;
  baseUrl: string;
  apiKey: string;
  videoBuf: Buffer;
}): Promise<void> {
  const { taskId, userId, projectId, episodeIdParam, episodeNumber, model, targetLanguage, characterDefs, baseUrl, apiKey, videoBuf } = input;
  try {
    const allEpisodes = await episodeRepo.listByProject(projectId);
    const prevEpisodes = allEpisodes
      .filter((e) => e.episodeNumber < episodeNumber)
      .sort((a, b) => a.episodeNumber - b.episodeNumber);
    const projectAssets = await listAssets(projectId);

    const characterMap = new Map<string, string>();
    const nameMap = new Map<string, string>();
    for (const ep of prevEpisodes) {
      const sd = (ep.scriptData ?? {}) as Record<string, unknown>;
      const shots = Array.isArray(sd.referenceVideoShots) ? sd.referenceVideoShots as K3Shot[] : [];
      for (const shot of shots) {
        for (const char of shot.characters) {
          if (!characterMap.has(char)) characterMap.set(char, '');
        }
      }
    }
    for (const asset of projectAssets) {
      if (asset.kind === 'CHARACTER' && asset.name) {
        if (!characterMap.has(asset.name)) characterMap.set(asset.name, '');
        if (asset.description) characterMap.set(asset.name, asset.description);
      }
    }
    if (targetLanguage) {
      for (const ep of prevEpisodes) {
        const sd = (ep.scriptData ?? {}) as Record<string, unknown>;
        const translated = Array.isArray(sd.referenceVideoShots) ? sd.referenceVideoShots as K3Shot[] : [];
        const raw = Array.isArray(sd.referenceVideoShotsRaw) ? sd.referenceVideoShotsRaw as K3Shot[] : [];
        for (let i = 0; i < raw.length && i < translated.length; i++) {
          const rawDialogue = raw[i]?.dialogue || '';
          const transDialogue = translated[i]?.dialogue || '';
          if (rawDialogue && transDialogue) {
            const rawParts = rawDialogue.split(':');
            const transParts = transDialogue.split(':');
            if (rawParts.length >= 2 && transParts.length >= 2) {
              const rawText = rawParts.slice(1).join(':').trim();
              const transText = transParts.slice(1).join(':').trim();
              if (rawText && transText) nameMap.set(rawText, transText);
            }
          }
        }
      }
    }

    const continuityContext = prevEpisodes.length > 0
      ? prevEpisodes.map((ep) => {
          const sd = (ep.scriptData ?? {}) as Record<string, unknown>;
          const shots = Array.isArray(sd.referenceVideoShots) ? sd.referenceVideoShots as K3Shot[] : [];
          const lastShots = shots.slice(-3);
          return 'EP' + ep.episodeNumber + ' 末尾镜头：\n' + lastShots.map((s) =>
            '- ' + s.characters.join('/') + ' ' + s.action + ' @ ' + s.location + ' (' + s.shotType + ' ' + s.cameraAngle + ')'
          ).join('\n');
        }).join('\n\n')
      : '';

    const characterContext = characterMap.size > 0
      ? '已确定的角色代号（沿用这些代号识别同一角色）：\n' +
        Array.from(characterMap.entries()).map(([code, desc]) =>
          '- ' + code + (desc ? ': ' + desc : '')
        ).join('\n')
      : characterDefs;

    const nameMappingContext = nameMap.size > 0
      ? '已确定的翻译映射（保持一致）：\n' +
        Array.from(nameMap.entries()).slice(0, 50).map(([zh, en]) => '"' + zh + '" → "' + en + '"').join('\n')
      : '';

    // Step 1: Upload
    await reportInlineAiTaskProgress(taskId, userId, 15, '正在上传视频', 0);
    const uploadResult = await uploadToKimi(apiKey, baseUrl, videoBuf, 'video.mp4');
    const fileReference = 'ms://' + uploadResult.id;

    // Step 2: K3 analysis
    await reportInlineAiTaskProgress(taskId, userId, 30, '正在分析镜头', 0);
    const analysisRaw = await callK3Chat(apiKey, baseUrl, model, [
      { role: 'system', content: '你是专业影视分镜分析师。你的输出是纯 JSON，不带任何 markdown 格式或解释文字。' },
      {
        role: 'user',
        content: [
          { type: 'video_url', video_url: { url: fileReference } },
          {
            type: 'text',
            text: [
              '逐镜头分析这段视频，输出 JSON 数组。每个镜头包含：',
              '- index: 序号（从1开始）',
              '- startTime: 开始时间（秒，精确到0.1）',
              '- endTime: 结束时间（秒，精确到0.1）',
              '- shotType: 景别（CU特写/MCU近景/MS中景/WS全景）',
              '- cameraAngle: 机位（正面/侧面/过肩/俯拍/仰拍/背面）',
              '- characters: 出场角色代号数组（' + characterContext + '）',
              ...(continuityContext ? ['', '【跨集衔接】前面集的结尾镜头（保持连贯）：', continuityContext] : []),
              '- action: 动作描述（简练，只描述实际看到的）',
              '- emotion: 情绪和表情',
              '- dialogue: 台词原文，格式 "代号: 台词"，无台词写空字符串',
              '- setting: 室内或室外',
              '- location: 场景环境描述',
              '',
              '只分析实际画面内容，不要脑补或推测未出现的情节。',
              '输出格式：纯 JSON 数组，不要 markdown code block，不要解释文字。',
              '示例格式：[{"index":1,"startTime":0,"endTime":2.5,"shotType":"CU","cameraAngle":"正面","characters":["ML1"],"action":"站在拱廊下，侧目看向右侧","emotion":"冷峻沉稳","dialogue":"","setting":"室外","location":"欧式砖石拱廊"}]',
            ].join('\n'),
          },
        ],
      },
    ]);

    const shots = extractJsonArray(analysisRaw);
    if (shots.length === 0) throw new Error('K3 分析未提取到镜头，请重试');

    // Step 3: translate
    let finalShots = shots;
    if (targetLanguage) {
      await reportInlineAiTaskProgress(taskId, userId, 60, '正在翻译', 0);
      finalShots = await translateShots(shots, targetLanguage, userId, nameMappingContext);
    }

    // Step 4: persist
    await reportInlineAiTaskProgress(taskId, userId, 80, '正在保存', 0);
    await billDirectGeneration({
      userId,
      result: { url: '', meta: {}, cost: undefined },
      description: 'K3 视频逐镜头分析' + (targetLanguage ? ' + ' + targetLanguage + '翻译' : ''),
      taskType: 'VIDEO_TO_SCRIPT_FULL',
    });

    const proj = await projectRepo.getById(projectId);
    const scriptData = ((proj?.scriptData ?? {}) as Record<string, unknown>);
    scriptData.referenceVideoShots = finalShots;
    scriptData.referenceVideoShotsRaw = shots;
    scriptData.referenceVideoShotsLanguage = targetLanguage || 'source';
    scriptData.referenceVideoFileId = uploadResult.id;
    scriptData.referenceVideoAnalysis = analysisRaw;
    // 更新 referenceVideo.phase → 'done'，让 ReferenceVideoStage 刷新后恢复到正确阶段
    if (scriptData.referenceVideo && typeof scriptData.referenceVideo === 'object') {
      (scriptData.referenceVideo as Record<string, unknown>).phase = 'done';
    }
    await projectRepo.update(projectId, { scriptData });

    let episodeId: string;
    let existingScriptData: Record<string, unknown> = {};
    if (episodeIdParam) {
      const targetEp = await episodeRepo.getById(episodeIdParam);
      if (!targetEp || targetEp.projectId !== projectId) {
        throw new Error('目标分集不存在或无权访问');
      }
      episodeId = episodeIdParam;
      existingScriptData = targetEp.scriptData && typeof targetEp.scriptData === 'object' && !Array.isArray(targetEp.scriptData)
        ? (targetEp.scriptData as Record<string, unknown>) : {};
    } else {
      const ep = allEpisodes.find((e) => e.episodeNumber === episodeNumber);
      if (ep) {
        episodeId = ep.id;
        existingScriptData = ep.scriptData && typeof ep.scriptData === 'object' && !Array.isArray(ep.scriptData)
          ? (ep.scriptData as Record<string, unknown>) : {};
      } else {
        const created = await episodeRepo.create(projectId, { title: '第 ' + episodeNumber + ' 集' });
        episodeId = created.id;
      }
    }

    const k3Scenes = finalShots.map((s) => ({
      id: 'S' + s.index,
      time: 'Day',
      intExt: s.setting === '室内' ? 'INT' : 'EXT',
      location: s.location,
      characters: s.characters,
      content: [s.action, s.emotion, s.dialogue].filter(Boolean).join(' '),
    }));
    const episodeScenes = finalShots.map((s, idx) => ({
      id: 'S' + s.index,
      scene_id: 'S' + s.index + '-' + idx,
      location: s.location,
      time: 'Day',
      intExt: s.setting === '室内' ? 'INT' : 'EXT',
      characters: s.characters,
      content: [s.action, s.emotion, s.dialogue].filter(Boolean).join(' '),
    }));
    const combinedDialogue = finalShots.map((s) => s.dialogue).filter(Boolean).join('\n');

    await episodeRepo.update(episodeId, {
      novelText: combinedDialogue || analysisRaw.substring(0, 5000),
      videoScriptDraft: combinedDialogue || analysisRaw.substring(0, 5000),
      scriptData: {
        ...existingScriptData,
        scenes: k3Scenes,
        rawAnalysis: analysisRaw,
        referenceVideoShots: finalShots,
        // K3 最后一个镜头的 endTime = 视频总时长，让 StoryboardStage 跳过时长弹窗
        sourceVideoDurationSeconds: finalShots.length > 0
          ? Math.max(...finalShots.map((s) => s.endTime))
          : undefined,
        modelUsed: 'kimi-k3',
        analyzedAt: new Date().toISOString(),
      },
      scenes: episodeScenes,
      status: 'COMPLETED',
      stageStatus: 'assets',
    });

    if (proj?.status === 'DRAFT') {
      await projectRepo.update(projectId, { status: 'SCREENWRITING' });
    }

    await reportInlineAiTaskProgress(taskId, userId, 100, '完成', 100);
    await completeInlineAiTask(taskId, userId, { episodeId, shotCount: finalShots.length });
  } catch (err) {
    const safeError = err instanceof Error ? err.message : '分析失败';
    await failInlineAiTask(taskId, userId, safeError);
  }
}



// --- 提取 JSON 数组（容错 K3 的 markdown 包裹） ---
function extractJsonArray(text: string): K3Shot[] {
  // 尝试直接 parse
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter(isValidShot);
  } catch { /* fallthrough */ }

  // 尝试提取 code block 里的 JSON
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]);
      if (Array.isArray(parsed)) return parsed.filter(isValidShot);
    } catch { /* fallthrough */ }
  }

  // 尝试提取第一个 [ 到最后一个 ]
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.substring(start, end + 1));
      if (Array.isArray(parsed)) return parsed.filter(isValidShot);
    } catch { /* fallthrough */ }
  }

  return [];
}

function isValidShot(obj: unknown): obj is K3Shot {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return typeof o.index === 'number'
    && typeof o.startTime === 'number'
    && typeof o.endTime === 'number';
}

// --- DeepSeek 纯翻译（零改写，只换语言） ---
async function translateShots(
  shots: K3Shot[],
  targetLanguage: string,
  userId: string,
  nameMap: string,
): Promise<K3Shot[]> {
  const { provider, model } = parseModel('deepseek/deepseek-v4-flash');
  const result = await callAI(provider, model, {
    capability: 'text_generation' as const,
    input: {
      messages: [
        {
          role: 'system',
          content: [
            `你是翻译引擎。把以下 JSON 镜头数组中的所有中文文本字段逐字翻译成${targetLanguage}。`,
            '规则（严格）：',
            `1. 只翻译文字，禁止扩写、优化、补充、改写、重述任何内容`,
            `2. action / emotion / location / dialogue 字段翻译成${targetLanguage}，保持原意和长度`,
            '3. dialogue 格式保持 "代号: 台词"，只翻译台词部分',
            '4. shotType / cameraAngle / setting 也翻译',
            '5. characters 数组不变（角色代号不翻译）',
            '6. index / startTime / endTime 数值不变',
            '7. 文化名词直译（如 红包→red envelope，不要改成 wedding card）',
            '10. 输出纯 JSON 数组，与输入结构完全相同，字段数量和顺序不变',
            '9. 不要加任何解释、markdown、注释',
          ...(nameMap ? ['8. 以下翻译映射必须严格保持一致（不要改变已有翻译）：', nameMap] : []),
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify(shots, null, 2),
        },
      ],
      temperature: 0.1,
      maxTokens: 131072,
      thinking: 'disabled',
    },
    userId,
  });

  const meta = (result.meta ?? {}) as Record<string, unknown>;
  const content = typeof meta.content === 'string' ? meta.content : '';
  if (!content) return shots; // 翻译失败回退原文

  try {
    const translated = JSON.parse(content);
    if (Array.isArray(translated)) return translated.filter(isValidShot);
  } catch { /* fallthrough */ }

  // 尝试提取
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const translated = JSON.parse(content.substring(start, end + 1));
      if (Array.isArray(translated)) return translated.filter(isValidShot);
    } catch { /* 回退原文 */ }
  }

  return shots;
}

// --- Kimi Files API upload ---
async function uploadToKimi(apiKey: string, baseUrl: string, buf: Buffer, filename: string) {
  const boundary = '----dramaforge-k3-' + Date.now();
  const prefix = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="purpose"\r\n\r\nvideo\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n' +
    'Content-Type: video/mp4\r\n\r\n',
  );
  const suffix = Buffer.from('\r\n--' + boundary + '--\r\n');
  const body = Buffer.concat([prefix, buf, suffix]);

  const resp = await fetch(baseUrl + '/files', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': String(body.byteLength),
    },
    body,
  });
  const data = await resp.json() as { id?: string; status?: string };
  if (!data.id) throw new Error('Kimi upload failed: ' + JSON.stringify(data).substring(0, 300));
  return data;
}

// --- K3 chat with long timeout + max params ---
async function callK3Chat(apiKey: string, baseUrl: string, model: string, messages: unknown[]) {
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model,
          stream: false,
          messages,
          max_completion_tokens: 16384,
          reasoning_effort: 'medium',
        }),
      });
      const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      if (data.choices && data.choices[0]?.message?.content) {
        return data.choices[0].message.content;
      }
      lastError = data.error?.message || JSON.stringify(data).substring(0, 300);
      if (lastError.includes('overloaded') || resp.status === 429 || resp.status >= 500) {
        await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
        continue;
      }
      throw new Error('K3 failed: ' + lastError);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('K3 failed:')) throw err;
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < 4) {
        await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
        continue;
      }
      throw new Error('K3 请求失败: ' + lastError);
    }
  }
  throw new Error('K3 多次重试后仍失败: ' + lastError);
}
