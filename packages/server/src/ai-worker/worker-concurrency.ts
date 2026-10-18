// ============================================================
// AI Worker 并发配置（纯函数，不连接 Redis/数据库）
// ============================================================

/** 四类队列的独立并发配置，避免提高图片吞吐时连带放大视频内存占用。 */
export interface WorkerConcurrencyOptions {
  text: number;
  image: number;
  video: number;
  voice: number;
}

/**
 * 解析并限制环境变量中的并发数。
 * 图片任务主要等待远端 API，默认 4 可消化批量资产；text 任务同为远端 LLM 调用，
 * 默认 2（E3：原默认 1 串行过慢，批量剧本分析/提取堆积）；video/voice 默认 1，保护 1.8GB 服务器。
 */
export function resolveWorkerConcurrency(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkerConcurrencyOptions {
  const parse = (name: string, fallback: number): number => {
    const value = Number(env[name]);
    return Number.isInteger(value) && value > 0 ? Math.min(value, 16) : fallback;
  };
  const shared = parse('WORKER_CONCURRENCY', 1);
  return {
    text: parse('WORKER_TEXT_CONCURRENCY', 2),
    image: parse('WORKER_IMAGE_CONCURRENCY', 4),
    video: parse('WORKER_VIDEO_CONCURRENCY', shared),
    voice: parse('WORKER_VOICE_CONCURRENCY', shared),
  };
}
