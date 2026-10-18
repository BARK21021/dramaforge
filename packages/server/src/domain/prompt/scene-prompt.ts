// ============================================================
// ③ server/domain/prompt — 场景站位图（blocking image）出图提示词构建器
// ============================================================
//
// 每个含座位布局的场景生成一张「写实定场站位图」：按 spatialLayout 方位放置
// 【无脸人形占位】+ 烘焙可见道具，作为场景定调参考图喂给该场景所有镜头组，
// 锁死跨组空间地理（火山官方原则：空间关系「展示」比「描述」省事）。
//
// 关键：图中人物一律无脸（剪影/灰模），身份由角色参考图提供——既避免 Seedance
// >4 人 / 双胞胎上限，又躲开 ark「may contain real person」真人审核。
//
// 纯函数，零 ffmpeg；项目风格锁（lockContentZh/En）由调用路由前置拼接到返回值前。
// ============================================================

export interface BlockingImageScene {
  location?: string | null;
  time?: string | null;
  intExt?: string | null;
}

/**
 * 构造场景站位图出图 prompt 主体（不含项目风格锁；调用方前置 styleLock）。
 *
 * @param scene        场景元信息（地点 / 时间 / 内外景）
 * @param spatialLayout analyzing 提取的座位布局（如「林夏(左前·驾驶位)、赵默(右前·副驾)」）
 * @param propNames    该场景可见道具名（已烘焙进图，省独立参考图名额）
 * @param opts.styleLock 项目五维风格锁文本（lockContentZh/En），置顶最高优先级
 */
export function buildBlockingImagePrompt(
  scene: BlockingImageScene,
  spatialLayout: string,
  propNames: readonly string[] = [],
  opts: { styleLock?: string } = {},
): string {
  const location = (scene.location ?? '').trim();
  const timeOfDay = (scene.time ?? '').trim();
  const intExt = (scene.intExt ?? '').trim();
  const setting = [location || '场景', timeOfDay, intExt].filter(Boolean).join(' · ');
  const layout = (spatialLayout ?? '').trim();
  const props = propNames.map((name) => name.trim()).filter(Boolean);

  const body = [
    `场景空间站位图（写实定场全景，仅用于锁定空间布局与道具位置，不用于人物身份）：${setting}。`,
    layout
      ? `按以下方位放置【无脸人形占位】（统一灰色剪影人体模型：无面部、无五官、无发型、无服装细节，仅表示位置与朝向）：${layout}。`
      : '画面中按场景需要放置【无脸人形占位】（统一灰色剪影人体模型：无面部、无五官、无发型、无服装细节，仅表示位置与朝向）。',
    props.length > 0 ? `画面中如实摆放可见道具：${props.join('、')}。` : '',
    '锁死家具、建筑结构与空间地理关系；所有人物必须是无脸占位，严禁出现任何可辨认的人脸、五官、表情、发型或具体角色形象。',
    '镜头：广角定场全景，单张完整画面，水平视角，构图稳定，前后景层次清晰，自然光照。',
    '只输出一张完整的定场图：严禁分屏、双框、正反打或多格漫画式布局（镜像 LOCATION 资产生图模板的「单框全景」约束）。',
  ].filter(Boolean);

  return [opts.styleLock ?? '', ...body].filter(Boolean).join('\n\n');
}
