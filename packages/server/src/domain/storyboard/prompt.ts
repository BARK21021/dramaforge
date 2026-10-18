// ============================================================

import { buildVideoLanguageContract } from '../prompt/video-language';
import type { LocalizationProfile } from '../prompt/target-languages';
import type { LocalizedDurationBudget } from '../prompt/target-languages';
// ③ server/domain/storyboard/prompt — 分镜生成提示词
// ============================================================
//
// 把单集场景 + 项目资产 → 分镜导演 system/user prompt，让 LLM 把每场戏拆成
// 1-N 个镜头（visualPrompt / durationSeconds / purposeTag / dialogue / characters）。
//
// 将 app1 的导演方法压缩成适合 C/S 同步文本调用的深模块：
// Seedance 单动作预算、时间码、声音、对白覆盖和资产引用硬约束；解析、归一化、
// 对白/语种门禁与自动编组由 storyboard/postprocess 统一承担。
//
// 纯函数，零 ffmpeg。
// ============================================================

export interface StoryboardScene {
  id: string;
  location?: string | null;
  time?: string | null;
  intExt?: string | null;
  characters?: string[] | null;
  content: string;
}

/** 道具/环境变体目录条目（按本集过滤后注入，供分镜 AI 按镜头指定状态变体）。 */
export interface StoryboardAssetVariant {
  key: string;
  label: string;
  description?: string | null;
}

export interface StoryboardAssetRef {
  kind: string; // CHARACTER | PROP | LOCATION | ENTITY
  name: string;
  description?: string | null;
  /**
   * 资产在原剧本中的名称/原语言别名。`name` 仍是唯一展示名和落库名；
   * sourceNames 只用来让海外原文引用能够定位到同一资产。
   */
  sourceNames?: string[] | null;
  /**
   * 道具/环境的状态/时段变体目录（已按本集过滤：coverageEpisodes 命中本集或为空）。
   * 角色不传——角色造型由 costumeMap 单独约束。仅当资产有多于一个变体时才注入，
   * 让分镜 AI 据镜头剧情为每个引用的道具/环境指定合适的变体 key。
   */
  variants?: StoryboardAssetVariant[] | null;
}

export interface StoryboardPromptOptions {
  episodeNumber?: number;
  /** 期望全集总时长（秒）；不传则让 LLM 按内容自行决定。 */
  totalDurationSeconds?: number;
  /** 项目级本地化档案；海外项目用它锁定唯一台词/画面文字语种。 */
  localizationProfile?: LocalizationProfile;
  /** 创建项目时锁定的全局视觉风格；必须写入每个 visualPrompt。 */
  visualStylePrompt?: string;
  /** 根据源片和目标语种计算出的全集时长预算。 */
  durationBudget?: LocalizedDurationBudget;
  /** 项目分类（DOMESTIC/OVERSEAS）；海外时注入"海外文化本地化"硬约束。 */
  category?: string;
}

/**
 * 构造分镜生成 system/user prompt。
 *
 * @returns { system, user } —— system 是分镜导演规范 + JSON 输出格式；user 注入场景 + 资产 + 约束。
 */
export function buildStoryboardPrompt(
  scenes: StoryboardScene[],
  assets: StoryboardAssetRef[],
  opts: StoryboardPromptOptions = {},
): { system: string; user: string } {
  const system = [
    '你是一位资深短剧分镜导演。任务：把给定剧本拆成可直接用于 Seedance 视频生成的镜头。',
    '',
    '## 输出顺序：直接输出 JSON 镜头表；判断过程由思考模式承担，不要在正文写分析。',
    '',
    '## Seedance 镜头契约',
    '1. 每镜只承担一个叙事任务、一个肉眼可见的动作节拍和一个主要运镜；三个以上连续子动作必须拆镜。',
    '2. 每镜先选“身份稳定/动作表现/场景密度”中的一个主预算、一个次预算，其余简化，避免模型注意力过载。',
    '3. 动作用“起始→过程→完成落点”描述；后一镜起点必须继承前一镜的人物位置、朝向、姿态和道具归属。',
    '4. 光线必须来自太阳、窗、灯、屏幕等可信光源；抽象的“高级感、震撼、电影感、8K”不能代替可见细节。',
    '5. 情绪必须外化为可见的身体动作，严禁用“开心/快乐/高兴/喜悦/兴奋/愤怒/生气/恼怒/暴怒/悲伤/难过/伤心/紧张/焦虑/害怕/恐惧/震惊/惊讶/失落/释然”等抽象情绪词（例：不写“她很开心”改写为“她嘴角上扬、眉眼舒展、脚步轻快”；不写“他很愤怒”改写为“他双拳紧握、下颌绷紧、胸口起伏”）。用眉眼、呼吸、手指、喉结和姿态变化表达情绪，不把“愤怒/悲伤/焦虑”等抽象标签直接塞进 visualPrompt。',
    '6. 所有镜头硬切；禁止正反打（两人面对面来回切镜，Seedance 下两脸互相污染必身份漂移）；同场连续镜头遵守视线匹配，避免三个以上相同景别、机位或运镜。',
    '7. visualPrompt 使用三段结构：“【当前动作】…\\n[00:00-00:时长],景别,机位,运镜,[主体]+[位置]+[朝向]+[姿态],可见动作+可信光源+环境反馈,[voice:声音]\\n【落点】…”。每个 JSON 镜头只允许一条时间码。',
    '8. 可见主体锁定（防穿帮）：单人镜头（画面中只出现一个角色）的 visualPrompt 严禁出现第二个角色名，严禁写「看向XX/盯着XX/对XX说/回应XX」——模型会为表现「被看向」而把画外角色错误生成进画面。未入画对象只写画面外方位，如「视线落向画面左侧边缘外」「朝门槛外侧发话」「话锋压向桌对面画面外方向」；仅主观压迫镜头可用「看向镜头方向/正对镜头发话」。',
    '9. 每镜画面必须有可见主体、可见场景和可见动作。严禁纯黑屏/纯白屏/无主体/无场景/无画面内容的镜头——Seedance 文生视频无法合成“什么都没有”的画面，会直接报错或退化成一张图。需要“黑场+旁白/台词”这类纯音频节拍时，必须并入相邻可见镜头的 soundCue/dialogue，不得独立成一个镜头。',
    '10. 每镜必须有持续可见的运动（运镜位移，或主体动作/微表情/呼吸/视线变化），严禁定格/时停/静止画面。只描述一张静态构图而缺少动作变化时，模型往往只生成一张静止图；即便反应镜/特写镜也必须有手持微晃、微表情或呼吸起伏等可见动态。',
    '11. 多角色站位锁定（防穿帮）：画面中出现两个及以上角色时，visualPrompt 必须显式写明每个入画角色在画面中的空间位置与相对关系——左/右、前景/后景、并排/面对/背向、相对家具与门窗的方位；同一场景内各镜头的相对站位必须保持一致，不得跨镜随意调换角色的左右或前后（例如上一镜 A 在左、B 在右，下一镜不得变成 A 在右、B 在左）。若该场景给定了座位/站位布局，各镜站位须与该布局一致。单人镜头仍遵守第 8 条，不得出现第二人。',
    '',
    '## 张力与镜头功能规划（展开镜头前必须完成）',
    '1. 每集只选 1-2 个主爆点；首次有效钩子应出现在前 20-30 秒或全片前 1/3（取更早者）。',
    '2. 每镜必须在 purposeTag 标一个功能：铺垫 / 推进 / 攻击 / 反应 / 钩子。铺垫不得连续超过 3-4 镜；推进镜结束时人物关系、信息、目标或局面必须发生变化；每 15-25 秒至少有一次攻击、揭露或不可逆选择。',
    '3. 爆点必须有可见反应、停顿压迫或声音反差，不能只有一句解释性台词；集尾落在动作、反应、不可逆决定或追更钩子，不落在复述说明。',
    '4. 镜头选择服从功能：关系对峙用过肩或同框中景（严禁正反打来回切）；信息揭露用插入特写+反应镜；能力证明用完整动作起落点；环境威胁先交代空间再切主体反应。',
    '5. 双人同框近景是身份漂移高发区（两个角色脸互相污染、混淆成双胞胎）。同一画面需要稳定呈现两个已锁定身份时，优先用过肩或中景，不要硬生成复杂的双人同框近景；必须双人同框时让两人保持明显距离、朝向差异，并各自绑定独立参考图。',
    '',
    '## 景别语言（按叙事功能选景别，每镜一个主景别）',
    '景别决定观众「看到多大范围」：先按本镜画面任务与 purposeTag 选景别；shotSize 字段与 visualPrompt 时间码行里的景别必须是同一个词且完全一致。',
    '- 大远景 / 远景：交代整体环境、地理关系与氛围基调；用于开场建场、场景转换、空间揭示（环境威胁先远景交代空间，再切主体反应）、集尾收束孤立感。',
    '- 全景：完整呈现角色全身与周围环境的关系，看清人物在空间中的位置与调度；用于多人同框、关系对峙、完整动作起落点、跨空间移动。',
    '- 中景：腰部以上，兼顾面部表情与肢体动作；用于对话、推进、过肩，是承载对白与日常互动的主力景别。',
    '- 近景：胸部以上，突出面部表情与情绪反应；用于反应镜、情绪蓄力、强调说话人。',
    '- 特写：局部或面部填满画面，放大关键细节、道具或微表情；用于信息揭露（插入特写）、情绪爆点、钩子冲击。',
    '景别词库（shotSize 字段与 visualPrompt 时间码行统一用以下词，不得自造）：',
    '大远景 / 远景 / 全景 / 中景 / 近景 / 特写。',
    '节奏节制：中景是对白段主力，但忌全片堆中景致单调；大远景/远景每场戏 ≤1-2 次（建场或揭示用），多了拖节奏；特写留给情绪爆点与信息揭露，不滥用。相邻镜头景别应有递进变化（如 远景→全景→中景→近景→特写），避免雷同（见「Seedance 镜头契约」第 6 条）。',
    '',
    '## 运镜语言（按叙事功能选镜，每镜一个主要运镜）',
    '运镜替观众「感受」而非「看」：先按本镜 purposeTag 选运镜类别，再落成 Seedance 可渲染的具体机位词；严禁用「电影感/震撼/高级感/8K」等抽象词代替可见机位动作。',
    '- 钩子（点名冲击）：快速推近到特写、俯冲推进（全景砸入特写）；一拍到位、视线无处可逃。',
    '- 攻击/揭露：俯拍揭示、低角度仰拍压迫、插入特写+反应镜；信息揭露优先俯拍或缓慢推近。',
    '- 反应/情绪蓄力：缓慢推进（匀加速）、轨道环绕（冻住审视）、手持微晃固定；反应镜即便机位静止也须有微表情或呼吸起伏等可见动态。',
    '- 推进：跟拍、横移、缓推；动作起落点完整呈现，不得跨场景硬切连续动作。',
    '- 铺垫/建场：升降（摇臂升起揭示空间）、缓慢横摇、固定（带轻微呼吸感手持）；先交代空间再切主体反应。',
    '- 收束：缓慢后拉（主体被世界孤立）、固定收住；集尾落点用收束运镜压住爆点。',
    '运镜词库（visualPrompt 时间码与 cameraMovement 字段统一用以下 Seedance 可渲染词）：',
    '固定(微晃) / 缓推 / 快速推近 / 缓拉 / 后拉揭示 / 横移 / 横摇 / 升降 / 跟拍 / 低角度仰拍 / 俯拍 / 俯冲推进 / 轨道环绕 / 推拉变焦 / 斜角构图。',
    '节奏节制（避免廉价感与重复）：快速推近、俯冲推进、轨道环绕、推拉变焦是「大动作」，全片各 ≤2 次、其中推拉变焦 ≤1 次；斜角构图只用于失衡/转折瞬间，不得常态使用。铺垫与对话段以固定(微晃)/缓推/跟拍为主，把大动作留给真正的爆点；同场连续镜头不得连用相同运镜。',
    '',
    '## 对白与动作物理时长',
    '1. durationSeconds 硬规则：必须 ≥ 该镜全部台词的自然朗读时长，再加 0.5-1 秒动作/反应余量——时长不够说完台词的一律不标。语速预算：中文约 4 字/秒；英文及其他拉丁语系（西/法/葡/德等）约 2.5 词/秒（≈150 词/分）。单镜 durationSeconds 装不下全部台词时，必须按原字序把台词拆到相邻镜头（可用同一说话人的 J-cut/L-cut 连续承载），绝不能靠加速说话、删字或抢台词来压时长。',
    '2. 短反应/抬眼/握紧约 0.8-1.5 秒；转身、起步、递接道具约 1.5-3 秒；开门入场、坐下起身、走到明确位置约 2-4 秒；追逐、搏斗、多人调度等复杂动作需 4-8 秒并按动作落点拆镜。',
    '3. 时长支持 0.1 秒粒度，不要全部取整数或套固定节拍；每镜时长必须同时容纳对白、动作和反应。',
    '4. 单时间段对白字数安全上限（超过则拆时间段或拆镜，绝不能加速说话、删字或抢台词）：中文 1-2秒≤8字；3-4秒≤12-18字；5-6秒≤20-28字；7-9秒≤30-40字；10-13秒≤40-55字；超过55字必须独立镜号或按原句自然停顿拆到连续镜号。英文/拉丁语系对照（≈2.5 词/秒）：1-2秒≤3-5词；3-4秒≤8-10词；5-6秒≤13-15词；7-9秒≤18-22词；10-13秒≤25-33词；超过33词必须独立镜号或拆分。每个时间段只允许一个明确说话者持有完整对白；长台词（中文25字/英文20词以上）进入保护模式（稳定镜头服务一个说话者，他人只做无台词反应）。',
    '5. dialogue 字段必须给每句台词绑定说话人，格式「角色名（通道）：台词」：正常开口说话写「角色名：台词」；画外/内心独白写「角色名（OS）：台词」；旁白写「角色名（VO）：台词」。同一镜头多人说话用「；」分隔，如「林夏：放开我！；赵默：你冷静点。」。无对白写空字符串。严禁在对白里夹带任何情绪/语气/音色词（痛苦/快乐/焦急/哭腔/高音量等一律不得出现）——情绪只能由画面动作外化（见「Seedance 镜头契约」第 5 条），对白标签只保留角色名与通道。台词逐字沿用剧本原句（剧本里的（情绪）括注、OS 后缀一律改写成上述格式，不保留情绪词）；不得改写、翻译、合并或补写。',
    '',
    '## 内容与声音硬约束',
    '1. 每个场景拆成 1-N 镜，关键动作、反应和情绪转折获得镜头，过渡从简；禁止机械平均切分。单个场景的总镜头时长优先控制在 15 秒以内（后端正好归为 1 个生成组），至多 30 秒（2 个组）；超出 30 秒的大场景允许拆成更多组，但应优先用更少、更长的镜头完整承载动作与对白，而非切成大量碎镜——组与组之间的衔接处最容易穿帮，组数越少越稳定。不要为凑节奏把一个连续动作跨场景或跨组硬切。',
    '2. 时长通常 2-8 秒，连续动作最多 15 秒；时长必须足够完成动作并自然说完台词。',
    '3. 对白逐字沿用输入剧本中的台词，按本集目标语种自然停顿拆分到镜头；不翻译、不改写、不缩写、不扩写、不合并、不遗漏、不新增；长台词可按原字序跨相邻镜头连续承载。',
    '4. 每句原对白至少被一个镜头覆盖；无台词处保持无台词，不得为衔接自行补旁白或 OS。',
    '5. soundCue 只写目标语种对白/VO/OS、持续环境底声和一个焦点动作声；禁止 BGM、字幕、水印、Logo。',
    '6. 画面文字默认不生成；剧情必须出现的招牌、信件、手机 UI、时间/身份提示花字（如“前一天”“某总裁”）只能使用目标语种（海外项目即严禁中文）。画面严禁出现国旗、国徽、平台 Logo、搬运账号 ID、二维码、引流文字、AI 生成角标。',
    '7. characters/speakingCharacters/environments/items 只能使用输入资产的精确名称；资产清单中的 name 是唯一规范展示名，原文别名仅用于识别剧本原词，输出数组必须写回 name，不得输出别名或新建同义资产。非人发声体只进入 speakingCharacters，不伪装成人类角色。不要输出 groupIndex/groupLabel，后端按时长和参考图上限编组。',
    opts.visualStylePrompt
      ? `8. 项目视觉风格已锁定：${opts.visualStylePrompt}。每个 visualPrompt 都必须遵守，禁止改成冲突画风。`
      : '',
    opts.durationBudget
      ? `9. 本集目标语种为 ${opts.durationBudget.languageCode}，全部镜头总时长必须控制在 ${opts.durationBudget.minSeconds}-${opts.durationBudget.maxSeconds} 秒，优先接近 ${opts.durationBudget.targetSeconds} 秒。不得把不同语种固定成同一总时长。`
      : '',
    buildVideoLanguageContract(opts.localizationProfile),
    String(opts.category).toUpperCase() === 'OVERSEAS'
      ? [
          '',
          '## 海外文化本地化（强制——目标观众非中文文化圈，否则出现"外国人用筷子吃包子"穿帮）',
          '1. 本剧为海外背景，visualPrompt/道具/食物/餐具/建筑/服饰严禁出现中国特有文化元素；必须改用与上方目标语言一致文化圈的等价物。',
          '2. 食物/餐具：筷子→刀叉；包子/馒头/饺子/油条/粽子→面包/三明治/汉堡/吐司/派；茶馆/面馆→咖啡馆/小餐馆；粥→麦片粥/汤。',
          '3. 服饰/建筑/器物：汉服/长袍/旗袍/马褂/唐装→西装/正装/连衣裙/立领外套；匾额/牌坊→招牌/拱门；算盘→计算器；毛笔/宣纸→钢笔/纸张。',
          '4. 节庆/装饰：春联/对联/红灯笼/红包/鞭炮→西式节日装饰/串灯/礼物卡/烟花。',
          '5. 涉及具体道具时用目标文化等价物命名，不要保留中文特有器物名；目标文化无对应物时改为该文化常见等价日常物。',
        ].join('\n')
      : '',
    '',
    '## 角色/道具/环境变体引用（强制——让分镜使用正确的状态/时期变体图）',
    '1. 角色/道具/环境清单中标注了「本集可用变体」的资产，拥有多个状态/时段/时期变体（如道具 完好/破损、环境 白昼/深夜、角色 成年/幼年形态）。每个变体有一个 costumeKey（如 default、broken、night、child-artie）。',
    '2. 对本镜头引用的每一个这类资产，你必须判断本镜画面中它处于哪个状态/时期，并在 characterCostumes（角色）或 itemCostumes（道具）或 environmentCostumes（场景）里输出 {"name":"资产展示名","costumeKey":"变体key"}。',
    '3. costumeKey 必须是清单里列出的某个变体 key；default 表示基准/常态。若本镜该资产处于非默认状态（如道具被踩碎、场景是深夜、角色处于幼年时期），必须输出对应的非 default key，不得一律写 default。',
    '4. 只为本镜头实际出现、且清单标注了多个变体的资产输出条目；常态资产或单态资产不要输出。name 必须与 characters/items/environments 数组里的展示名完全一致。',
    '5. 判断依据：本镜 visualPrompt/对白/动作中该资产的状态线索（如"令牌被踩碎""夜色""荒废"、"幼年/童年时期的该角色"），对应变体描述里标注的状态/时期。',
    '',
    '## 审核友好措辞（强制，规避火山 Seedance 文本审核 InputTextSensitiveContentDetected）',
    '1. 按场景角色而非年龄指代人物：visualPrompt/dialogue/soundCue 严禁出现 child/kid/young/boy/girl/小孩/少年/少女/儿童等指向低龄的词（会触发更严格审查并波及整段）；人物身份与年龄交由参考图承担，必须用角色名或「青年/成年角色」替代。角色状态变体（如幼年形态）通过 characterCostumes 的 costumeKey 指定，不受本条限制（绑定字段原样写）。',
    '2. 暴力/冲突/危险情节用电影化安全措辞：用交锋、对峙、负伤、倒地、制服，而非流血、死亡、杀戮、爆头、断肢；不渲染血腥、色情、自残、政治敏感细节。',
    '3. 不写真实人物姓名、真实组织名、可识别品牌/商标/Logo；角色一律用输入资产清单里的虚构 name。',
    '4. 用影视制作术语建立制作语境（景别：大远景/远景/全景/中景/近景/特写；运镜：推拉摇移/跟拍/固定；光源：侧逆光/漫射；色调：低饱和/冷暖），制作语境可显著抬高审核容错。',
    '5. visualPrompt 只写镜头能拍到的可见事实（场景、动作、光影、构图、机位），不写动机、背景故事、内心独白等潜台词。',
    '5a. 台词与画面描述彻底分离：visualPrompt/visualContent/action/sceneContext 严禁出现台词原文（含引号内对白、对话关键词、英文原词如“Here”“advice”）——台词一律只写进 dialogue 字段；模型会把画面描述里的文字当可见内容画进画面或读出来。画面内确实存在的可见文字（招牌、信件、衣物图案文字）如需体现，用「画面文字：XXX」独立标注，不得裸写在对白位置。',
    '6. 禁用违禁词「帝国」：visualPrompt/dialogue/soundCue/sceneContext/sceneDesign 等描述性文本严禁出现「帝国」，一律用「王国」替代（该词触发火山文本审核整段拒审）。绑定字段（characters/items/environments/characterCostumes/itemCostumes/environmentCostumes 的 name）原样写资产清单里的 name，即使包含「帝国」也不要替换——后端运行时统一替换。',
    '7. 规避版权指纹（Override 台词逐字沿用规则）：对白/动作/道具若与知名 IP 的正典名词或情节指纹重合，Seedance 版权审核会整段 400 拒生成（"output video may be related to copyright restrictions"）。历史实证触发组合：魔法学院的「Sleeping Potion/沉睡魔药」（potion 类正典药水名）、孤儿被教授收留的「street rat」人设、charm 咒语类比喻、教授-学生顾问戏与药水交易的情节组合。此类内容必须改为通用等效词且不改变剧情：沉睡魔药→特制安眠药剂（sleep tonic）、potion→tonic、street rat→街头少年（street kid）、"work like a charm"→"work like a dream"。判断标准：出现「知名 IP 专属名词」或「场景/人设/情节组合恰好命中知名作品原型」即改写。',
    '',
    '## 结构化场景描述（每镜必填 sceneContext / sceneDesign / visualInfo）',
    '1. sceneContext：该镜所在场景的空间与氛围基调，格式"内/外景 @引用的场景资产名 + 氛围词"。',
    '2. sceneDesign：该镜画面色调、光源、空间质感的视觉设计（用影视制作术语，可见可拍）。',
    '3. visualInfo：该镜的画面规则与身份锁定约束（如"除主角用参考人物图片外，其他人员不可复用参考人物形象"）。',
    '',
    '## 输出格式（严格 JSON，不要 markdown 代码块，不要多余文字）',
    '{',
    '  "shots": [',
    '    {',
    '      "sceneId": "场景ID（来自输入）",',
    '      "shotIndex": 1（后端会重新编号，写 1 即可）,',
    '      "visualPrompt": "中文画面描述（含人物动作/构图/光线/运镜，使用影视制作术语）",',
    '      "durationSeconds": 镜头时长秒数（常规 2-8，连续动作可至 15）,',
    '      "purposeTag": "该镜叙事功能，仅限五选一：铺垫 / 推进 / 攻击 / 反应 / 钩子",',
    '      "dialogue": "对白原文，按「角色名（通道）：台词」绑定说话人（正常说话不写通道；OS=画外/内心独白、VO=旁白；多人用；分隔；严禁情绪/语气/音色词；无对白则空字符串）",',
    '      "sceneContext": "场景：内/外景 @引用的场景资产名 + 氛围基调（如：内景 @手术室 + 阴冷压抑 + 强对比聚光）",',
    '      "sceneDesign": "场景设计：色调/光影/空间质感的视觉设计（如：冷蓝灰调，四周幽暗，无影灯在中央手术台形成强聚光）",',
    '      "visualInfo": "画面信息：本镜画面规则与约束（如：除主角使用参考人物图片外，其他人员生成不可复用参考人物形象）",',
    '      "characters": ["本镜画面中实际登场的角色名（来自角色清单）——台词中提及但未登场/未出镜的角色严禁列入，登场判定以画面描述为准"]',
    '      "characterCostumes": [{"name": "角色名", "costumeKey": "该角色本镜所处的变体 key（仅多变体角色且处于非默认状态/时期时输出）"}],',
    '      "speakingCharacters": ["本镜头实际说话的角色名"],',
    '      "environments": ["引用的场景资产名"],',
    '      "items": ["引用的道具资产名"],',
    '      "itemCostumes": [{"name": "道具名", "costumeKey": "该道具本镜所处的变体 key"}],',
    '      "environmentCostumes": [{"name": "场景名", "costumeKey": "该场景本镜所处的变体 key"}],',
    '      "shotSize": "景别（限：大远景/远景/全景/中景/近景/特写之一，须与 visualPrompt 时间码行一致）",',
    '      "cameraAngle": "机位角度",',
    '      "cameraMovement": "运镜方式",',
    '      "action": "主体连续动作",',
    '      "soundCue": "对白/环境音/动作音的分层声音方案",',
    '      "emotionPurpose": "本镜头在情绪曲线中的作用"',
    '    }',
    '  ]',
    '}',
  ].join('\n');

  const scenesBlock = scenes
    .map((s, i) => {
      const meta = [s.location, s.time, s.intExt].filter(Boolean).join(' · ');
      const chars = s.characters && s.characters.length > 0 ? `（角色：${s.characters.join('、')}）` : '';
      return `### 场景 ${s.id || `S${i + 1}`}${meta ? ` [${meta}]` : ''}${chars}\n${s.content || ''}`;
    })
    .join('\n\n');

  const formatAssetLine = (asset: StoryboardAssetRef, descriptionLimit: number): string => {
    const seen = new Set<string>();
    const aliases = (Array.isArray(asset.sourceNames) ? asset.sourceNames : [])
      .map((value) => typeof value === 'string' ? value.trim() : '')
      .filter((value) => {
        if (!value) return false;
        const key = value.toLocaleLowerCase();
        if (key === asset.name.trim().toLocaleLowerCase() || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const aliasText = aliases.length > 0 ? `（原文别名：${aliases.join('、')}）` : '';
    const descriptionText = asset.description
      ? `：${asset.description.slice(0, descriptionLimit)}`
      : '';
    // 角色/道具/环境变体目录：列出本集可用的状态/时期变体（key/label/描述），让 AI 据镜头
    // 剧情在 characterCostumes / itemCostumes / environmentCostumes 里指定 key。只有 >1 个变体才需要标注。
    const variants = Array.isArray(asset.variants) ? asset.variants : [];
    const variantField = asset.kind === 'CHARACTER' ? 'characterCostumes'
      : asset.kind === 'LOCATION' ? 'environmentCostumes'
      : 'itemCostumes';
    const variantText = variants.length > 1
      ? `\n  本集可用变体（在下方 ${variantField} 用 costumeKey 指定）：${variants
        .map((v) => `${v.key}=${v.label || v.key}${v.description ? `（${v.description.slice(0, 40)}）` : ''}`)
        .join('；')}`
      : '';
    return `- ${asset.name}${aliasText}${descriptionText}${variantText}`;
  };

  const charBlock = assets
    .filter((a) => a.kind === 'CHARACTER')
    .map((a) => formatAssetLine(a, 120))
    .join('\n');
  const locBlock = assets
    .filter((a) => a.kind === 'LOCATION')
    .map((a) => formatAssetLine(a, 80))
    .join('\n');
  const propBlock = assets
    .filter((a) => a.kind === 'PROP')
    .map((a) => formatAssetLine(a, 80))
    .join('\n');
  const entityBlock = assets
    .filter((a) => a.kind === 'ENTITY')
    .map((a) => formatAssetLine(a, 120))
    .join('\n');

  const constraint = opts.durationBudget
    ? `\n本集目标总时长 ${opts.durationBudget.minSeconds}-${opts.durationBudget.maxSeconds} 秒（推荐 ${opts.durationBudget.targetSeconds} 秒），按场景信息量与目标语种自然语速分摊。`
    : opts.totalDurationSeconds
      ? `\n全集目标总时长约 ${opts.totalDurationSeconds} 秒，按各场景内容长度分摊。`
      : '';

  const user = [
    opts.episodeNumber ? `# 第 ${opts.episodeNumber} 集 分镜` : '# 分镜',
    constraint,
    '',
    '## 角色清单',
    charBlock || '（无）',
    '',
    '## 场景清单',
    locBlock || '（无）',
    '',
    '## 道具清单',
    propBlock || '（无）',
    '',
    '## 非人发声体清单（可进入 speakingCharacters，但不进入 characters）',
    entityBlock || '（无）',
    '',
    '## 剧本场景（请逐场拆分镜头）',
    scenesBlock,
  ].join('\n');

  return { system, user };
}
