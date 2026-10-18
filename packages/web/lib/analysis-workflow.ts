/**
 * 剧本分析工作流（F5 契约改 202）。
 *
 * 旧版（同步阻塞）：POST /analyze 同步等结果 → 自动跑资产提取 → 返 {analysis,assets}。
 * 新版（inline-task）：POST /analyze 拿 202 { taskId } → 立即返回 → 进度由 SSE 驱动。
 * 资产提取改为返回 needAssetExtraction 标记，由 AnalyzingStage 的 onComplete 触发
 * （而非此处顺序调用），避免阻塞导航。
 *
 * 进度不再在此处伪造百分比（旧 55/80/100 已删）——后台 runner 经 SSE 发分阶段
 * 实时进度，前端 GenerationProgress 绑 taskId 渲染。
 */

export interface AnalysisWorkflowProgress {
  /** 工作流百分比；阶段边界真实，阶段内部按耗时估算且在完成前封顶。 */
  value: number;
  /** 进度条主文案。 */
  label: string;
  /** 当前正在执行的服务端阶段。 */
  stage: string;
}

interface RunAnalysisWorkflowInput {
  api: (url: string, options?: RequestInit) => Promise<unknown>;
  projectId: string;
  episodeId: string;
  model?: string;
  enhancementPrompt?: string;
  localizationProfile?: unknown;
  onProgress?: (progress: AnalysisWorkflowProgress) => void;
}

export interface AnalysisWorkflowResult {
  /** inline-task 的 taskId（POST /analyze 202 返回）。 */
  taskId: string;
  /** 项目当前无资产时为 true（首次分析）—— 由 onComplete 触发自动提取。 */
  needAssetExtraction: boolean;
}

/**
 * 发起编剧分析（inline-task）。
 *
 * POST /analyze → 202 { taskId }（不 await AI 完成，后台 fire-and-forget）。
 * 查项目资产是否为空 → 返回 needAssetExtraction 供 onComplete 决策。
 *
 * @returns `{ taskId, needAssetExtraction }` 或 null（api 返回 null = 预检/鉴权失败）。
 */
export async function runAnalysisWorkflow({
  api,
  projectId,
  episodeId,
  model,
  enhancementPrompt,
  localizationProfile,
  onProgress,
}: RunAnalysisWorkflowInput): Promise<AnalysisWorkflowResult | null> {
  const encodedProjectId = encodeURIComponent(projectId);
  const encodedEpisodeId = encodeURIComponent(episodeId);

  onProgress?.({
    value: 12,
    label: "保存并分析中",
    stage: "正在提交编剧分析任务",
  });

  const analysis = await api(
    `/api/projects/${encodedProjectId}/episodes/${encodedEpisodeId}/analyze`,
    {
      method: "POST",
      body: JSON.stringify({
        model,
        enhancementPrompt: enhancementPrompt?.trim() || undefined,
        localizationProfile,
      }),
    },
  );
  if (!analysis) return null;

  // 202 契约：响应体 { taskId }（不再含完整分析结果）。
  const taskId =
    typeof analysis === "object" && analysis !== null
      ? (analysis as { taskId?: unknown }).taskId
      : undefined;
  if (typeof taskId !== "string" || !taskId) return null;

  // B：自动资产提取仅在「项目还没有任何资产」时跑（首次分析）。
  // 此处只查 + 返回标记；实际 POST /asset-extraction 由 onComplete 触发。
  const existing = await api(`/api/projects/${encodedProjectId}/assets`, {
    method: "GET",
  });
  const existingAssets = (existing as { assets?: unknown[] } | null)?.assets;
  const needAssetExtraction = !(
    Array.isArray(existingAssets) && existingAssets.length > 0
  );

  onProgress?.({
    value: 100,
    label: "保存并分析中",
    stage: needAssetExtraction
      ? "分析任务已提交，完成后将自动提取资产"
      : "分析任务已提交",
  });

  return { taskId, needAssetExtraction };
}
