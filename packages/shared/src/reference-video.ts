// ============================================================
// ① shared/reference-video — 参考视频转绘（REFERENCE_VIDEO）契约
// ============================================================
//
// OVERSEAS 项目的「参考视频转绘」内容来源：原视频在客户端本地按场景切割，
// 每个切片 720p 封顶、≤15s（ARK Seedance 参考视频上限）。切片上传到 MinIO
// 短 TTL presigned URL（有界瞬态，生成完即删，见 docs/known-issues/
// architecture-and-migration.md §H1 注记），分镜生成时每组参考对应场景切片
// 做 video-to-video 转绘（目标语种/海外人种与服饰由资产层改编驱动）。
//
// 元数据零字节：只描述切片（时间/尺寸/key），不承载任何媒体内容。
// ============================================================

/** ARK Seedance 参考视频单条上限（秒）。切割器按此封顶，超出会再拆。 */
export const REFERENCE_VIDEO_CLIP_MAX_SEC = 15;

/** 单项目参考视频切片数量上限（上传量界，防止批量滥用）。 */
export const REFERENCE_VIDEO_MAX_CLIPS = 40;

/** ffmpeg 场景检测默认阈值（select=gt(scene,τ)）。按真实素材冒烟微调。 */
export const REFERENCE_VIDEO_SCENE_THRESHOLD = 0.3;

/** 切片上传到 MinIO 的 TTL（秒）。7 天 = MinIO presign 上限。 */
export const REFERENCE_VIDEO_PRESIGN_TTL_SEC = 604800;

/** 单个切片的参考视频元数据（零字节，纯描述）。 */
export interface ReferenceVideoClipMeta {
  /** 0-based 切割序（也用于 UI「原片参考 C#<index>」徽标）。 */
  index: number;
  /** 在原视频中的起始秒。 */
  startSec: number;
  /** 在原视频中的结束秒。 */
  endSec: number;
  /** 切片时长（秒），≤ REFERENCE_VIDEO_CLIP_MAX_SEC。 */
  durationSec: number;
  /** MinIO 对象 key：`uploads/<userId>/reference-video/<projectId>/clip-<i>.mp4`。 */
  fileKey: string;
  /** 切片高度（≤720，720p 封顶）。 */
  height: number;
}

/** 项目级参考视频状态，持久化于 project.scriptData.referenceVideo。 */
export interface ReferenceVideoMeta {
  clips: ReferenceVideoClipMeta[];
  sourceDurationSec: number;
  uploadedAt: string;
}
