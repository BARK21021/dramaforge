# app1 → dramaforge-cs 提示词链与部署只读审计

审计日期：2026-07-23  
基准项目：`D:\app1`  
目标项目：`D:\dramaforge-cs`  
范围：整剧转风格、整剧/单集资产提取、编剧分析、分镜设计、镜头组视频提示词、资产/造型变体生图、原剧拆集，以及生产部署/回滚流程。

> 本审计只修改本报告，没有部署、没有连接生产环境、没有修改线上数据。工作树在并行修复中，行号可能继续移动；以下以函数名为主、行号为审计时参考。

## 2026-07-23 实施后更新

审计发现的 P0/P1 已在同一工作批次处理：分镜资产别名会统一回写中文规范名；分镜补齐张力、对白语速和动作物理时长规则；长视频补齐推进/钩子轮换、反模板、动态集数和元文本过滤；彩铅缓存只在真实存在时启用且最终恢复写实；资产负面词不再全局禁止眼镜/瞳色；编剧增强指导可从分集/项目持久化数据恢复；镜头组提示词先持久化再生成并校验变体图。下文“仍待修”保留为审计发生时的证据快照，不再代表当前代码状态。

## 结论

`dramaforge-cs` 不是“所有提示词都落后 app1”。资产提取、本地化时长、任务持久化、镜头组提示词快照、无损拆集等部分已经等于或优于 app1。真正影响质量和稳定性的剩余差异集中在四处：

1. **P1：分镜提示词与资产别名链仍未完整对齐。** 当前分镜导演 prompt 是 app1 的压缩版，而且只把资产 `kind/name/description` 传给模型及后处理；海外原文中的物品/环境名可能无法映射到中文展示资产名。
2. **P1：长视频重写 prompt 与灵石格式清洗落后 app1。** 缺少推进类型轮换、反模板、钩子轮换和元文本禁令，容易生成重复“打脸”套路，或把“本次只生成/续写批次”等模型过程文字混入剧本。
3. **P1：`pencilPaintingMode` 语义反了。** app1 是“先将角色参考图彩铅化，再要求最终视频恢复写实”；CS 当前却给最终视频追加“colored pencil animation”，会直接改变成片画风。
4. **P1/P2：资产生图负面词仍只部分对齐。** 本轮已补人脸道具和敏感词清洗，但 route 仍未使用风格/交付负面词 helper；而 helper 本身又不应原样照搬，因为它全局禁眼镜、蓝绿眼会改写剧情设定。

本轮已经修掉的高风险项包括：拆集 100% 原文完整性、含人脸道具的提示词矛盾、资产生图敏感词清洗、镜头组跨语言 `sourceNames` 查找、镜头组音色裸文件名契约、只哈希本组实际上下文、网格场景/道具误占 4 个角色名额。上述项仍需随全量测试一起验收。

## 优先级与状态总表

| 优先级 | 项目 | 当前状态 | 结论 |
|---|---|---|---|
| P0 | 原剧拆集允许丢正文 | **本轮已修** | `splitScriptIntoEpisodes` 现在最终强制拼接结果与冻结原文逐字符相等，否则拒绝写入；有冻结集数时走确定性 fallback。 |
| P0 | 含人脸道具 prompt 同时要求“不得出现人物” | **本轮已修** | `generate-image/route.ts` 已识别 `metadata.requiresCharacterRef`，要求角色参考图、传 `allowHumanFigure` 并追加人脸一致性。 |
| P0 | 镜头组 `/api/reference-audio/...` 被客户端当裸 wav 读取 | **本轮已修，待回归完成** | 组提示词上下文区分 provider/prompt URL 与 client bare filename，chain 仅把可由本地 manifest 读取的裸文件下发客户端。 |
| P1 | 分镜导演 prompt 的关键生产规则缺失 | **仍待修** | 建议模块化移植 app1 的张力表、对白语速/拆镜、动作物理时长、钩子/镜头功能与分场预算，不建议整段复制巨型 prompt。 |
| P1 | 分镜阶段不认识 PROP/LOCATION `sourceNames` | **仍待修** | `StoryboardAssetRef` 和 `normalizeAssetList` 只认展示名，海外原文名会被丢弃，后续镜头组也拿不到资产图。 |
| P1 | 长视频 rewrite 缺少反模板与元文本禁令 | **仍待修** | 直接移植 app1 `buildRewriteFromOutlinePrompt` 的近期质量规则，并给规则加快照/质量夹具。 |
| P1 | `cleanAiOutput` / `parseLingshiScript` 缺元文本过滤 | **仍待修** | 应移植 app1 对剧名/集头/场头起点识别及“续写、批次、AI 思考”等行过滤。 |
| P1 | `pencilPaintingMode` 最终输出画风相反 | **仍待修** | 必须改用 `PENCIL_PAINTING_RESTORATION_PROMPT`；没有已生成彩铅参考图时应禁用/拒绝，而不是只改最终 prompt。 |
| P1 | 镜头组资产别名、快照误判、音频契约 | **本轮已修，待回归完成** | 已改为 `sourceNames` lookup、精确上下文指纹、prompt URL/client file 分离。 |
| P1 | 资产生图敏感词与人脸道具 | **本轮已修** | 已使用 `sanitizePromptForModeration`，并修复人脸道具 reference/i2i 约束。 |
| P1 | 资产生图风格/交付负面词 | **部分待修** | route 仍是通用负面词 + 画风互斥词；应抽取“不会改剧情”的合规负面词，眼镜/瞳色只能在剧情未锁定时条件使用。 |
| P1 | 编剧分析增强指导只依赖本次请求 | **仍待修** | 请求未带 `enhancementPrompt` 时，应 fallback 到 episode/project 已持久化的 `analysisGuidance`。 |
| P2 | Full/Merge 长视频 prompt 固定 50~70 集 | **仍待修（潜在路径）** | app1 已按视频时长动态计算范围；CS `buildFullScriptPrompt`/`buildMergeScriptPrompt` 仍固定。当前主链主要用 outline + rewrite，优先级低于 rewrite 质量规则。 |
| P2 | 整剧资产提取结果偏浅且未显式 `maxTokens` | **仍待评估** | 当前整剧首遍只给 `name/description/source_names`，后续单集/项目提取会补丰富字段；长剧应显式 token 预算或分批，不宜盲目一次性输出完整富 schema。 |
| P2 | 网格 LOCATION/PROP 被当成“角色 4 张上限” | **本轮已修，待回归完成** | 角色上限只统计真实 CHARACTER，网格环境/道具只占总图片 9 张上限。 |

## 分链审计

### 1. 整剧转风格与原剧拆集

对照位置：

- app1：`src/core/ai/script-prompt.ts` 的 `buildTextStylePrompt`（约 722 行）、`cleanAiOutput`（约 975 行）。
- CS：`packages/server/src/domain/prompt/script-prompt.ts` 的同名函数；调用入口 `packages/web/app/api/projects/[id]/text-to-style/route.ts`。
- CS 拆集：`packages/server/src/domain/episode/split-service.ts` 的 `buildEpisodeSplitPrompt`、`splitScriptDeterministically`、`splitScriptIntoEpisodes`（约 114/171/334 行）。

已对齐/改进：

- 核心转风格 prompt 基本与 app1 同源。
- CS 海外模式改为只保留目标语言名，而不是 app1 的“中文名(目标语言名)”双语名。这是合理的产品改进，不应回退；代价是所有后续链必须消费 `sourceNames`/角色映射。
- 本轮拆集已从“LLM 复制全文再按长度覆盖率验收”升级为最终逐字符无损校验；冻结集数不匹配时走服务器确定性切分，最终再次校验，避免原剧与集数静默错位。

仍需注意：

- 明确存在 `第N集` 标记的原剧，最佳方案仍是优先按标记确定性切分；无标记时，让 LLM 返回边界/锚点，服务器切原文，比让 LLM 重抄全文更可靠。
- 原剧“海外转编/国内直出”应只做一次整剧转风格，再自动抽取整剧资产；每集阶段不应再次设置风格转绘。这个属于工作流门禁，不是单纯 prompt 文案问题。

### 2. 编剧分析

对照位置：

- app1/CS：`script-prompt.ts` 的 `buildScriptAnalysisPrompt`（约 229 行）、`parseScriptResult`。
- CS route：`packages/web/app/api/projects/[id]/episodes/[episodeId]/analyze/route.ts`，约 101-151 行构造指导词，195-205 行持久化结果。

已对齐/改进：

- 主 prompt、场景/信息点/造型表结构大体一致。
- CS 会注入完整前集脚本与已有资产，跨集连续性比简单复制 app1 更强。

仍待修：

- route 只读取本次 `body.enhancementPrompt`。用户换客户端、清 localStorage 或重试未带该字段时，先前保存的分析指导会静默失效。建议优先级：request → `episode.scriptData.analysisGuidance` → `project.scriptData.analysisGuidance`。
- `cleanAiOutput` 与 `parseLingshiScript` 尚未同步 app1 新增的元文本过滤。app1 约 998-1046、1181 行已经识别《剧名》、`第001集`、`[1-1`，并过滤“本次只生成、续写计划、批次、接上文、As an AI”等过程文字。

### 3. 整剧/单集资产提取

对照位置：

- app1：`src/core/ai/asset-prompt.ts` 的 `buildAssetExtractionPrompt`（约 251 行）。
- CS：`packages/server/src/domain/prompt/asset-prompt.ts` 同名函数（约 253 行）；`packages/server/src/domain/asset/whole-script-extraction.ts` 的 `extractWholeScriptAssets`（约 102 行）。

CS 当前整体优于 app1：

- PROP/LOCATION 强制中文展示名，同时保存原文 `source_names`。
- LOCATION 只抽固定建筑/空间，活动家具和独立物件归 PROP，减少环境图与道具图混杂。
- CHARACTER 支持服装变体和 `variant_type=period`，并明确跨造型身份锁、时段变体年龄差异。
- 单集/项目提取会注入项目风格、本地化档案、已有资产、角色映射与造型表。

不建议把整剧首遍直接改成一个超大的完整富 schema 调用。长剧一次返回角色、全造型、全环境、全物品和 coverage 很容易截断。更稳的方案是：首遍建立规范名/别名清单，随后按类型或剧集批量补全富字段，并加显式 `maxTokens` 与覆盖率验收。

### 4. 资产/造型变体生图

对照位置：

- app1：`src/core/ai/asset-prompt.ts` 的 `buildAssetImagePrompt`、`sanitizePromptForModeration`、负面词 helpers；`src/app/api/projects/[projectId]/assets/[assetId]/generate-image/route.ts` 约 172-267 行。
- CS：`packages/server/src/domain/prompt/asset-prompt.ts` 约 1293-1422 行；`packages/web/app/api/projects/[id]/assets/[assetId]/generate-image/route.ts` 约 173-299 行。

本轮已修：

- `requiresCharacterRef` 道具必须有角色参考图，允许人形，并追加脸型/五官/身份一致性；不再出现“提供人物参考图但 prompt 禁止人物”的自相矛盾。
- 角色服装/时段变体将 `description/identityLock/variantType` 注入真实生图 prompt；i2i 时明确保留身份，只改变造型允许维度。
- 正向 prompt 已过 `sanitizePromptForModeration`，降低 ARK 敏感文本 400。

仍待修：

- route 没有组合 `getStyleNegativePrompt` 和 `getDeliveryComplianceNegativePrompt`。但不能直接调用现有 helper：其全局包含眼镜、蓝眼、绿眼、异色瞳，会覆盖剧情或本地化设定。应拆成：
  - 永远适用：水印、Logo、二维码、账号、乱码、错误语言、裁脸、断肢、低质量；
  - 画风互斥：按项目锁定风格；
  - 剧情条件项：眼镜、瞳色等只有在资产描述/identity lock 未明确时才可加入。
- `sanitizePromptForModeration` 的 replacement 计数可写入 revision/debug metadata，便于区分“供应商问题”与“prompt 被清洗后语义变化”。

### 5. 分镜设计

对照位置：

- app1：`src/app/api/projects/[projectId]/generate-storyboard/route.ts`；场景切片约 244 行，导演 10 步约 395 行，张力表约 412 行，动作物理时长表约 521 行，分场预算约 650-720 行。
- CS：`packages/server/src/domain/storyboard/prompt.ts` 的 `buildStoryboardPrompt`（约 51 行）；`packages/server/src/domain/storyboard/postprocess.ts` 的 `normalizeAssetList`（约 70 行）和 `postprocessStoryboardShots`（约 118 行）；调用 route 约 115-178 行。

保留得较好的部分：一镜一动作/一主运镜、动作起点到落点、可见情绪、可信光源、180°轴线、对白逐字覆盖、时间码格式、项目风格与本地化时长预算。

缺失且会影响质量的部分：

- 主爆点、首次有效钩子、铺垫/推进/攻击分类和集尾类型的张力表。
- 对白语速上限、长台词跨相邻镜头拆分和 J/L-cut 处理。
- 动作物理时间参考与“复杂动作不能硬塞 4 秒”。
- 按剧情类型选择景别/机位/运镜，而不是仅要求变化。
- app1 的按场景、每段不超过约 500 字调用与场景局部时长配额。CS 当前把全集所有场景放进一次 LLM 调用，长集更易遗漏/截断/串场。
- 资产富字段没有进入导演 prompt；`StoryboardAssetRef` 只有 `kind/name/description`。
- 最关键的是：`normalizeAssetList` 只认展示名。应让资产携带 `aliases/sourceNames`，模型仍输出规范中文展示名；后处理将原语言引用确定性归一到规范名。

建议不要复制 app1 整个巨型 system prompt。应把“张力规划、对白/动作时长、镜头选择、资产绑定”拆成可测试模块，保留 CS 已有的目标语种时长预算，并按场景/结构化批次调用。

### 6. 镜头组提示词与视频生成

对照位置：

- app1：`src/core/ai/group-prompt.ts` 的 `collectReferenceAssets`（约 423 行）、`splitShotsByAssetLimit`（约 662 行）、`combineGroupPrompts`（约 1033 行）；`src/workers/video.worker.ts` 约 830-1045 行。
- CS：`packages/server/src/domain/prompt/group-preview.ts` 的同名函数（当前约 378/573/962 行）；`packages/web/lib/group-prompt-snapshot.ts` 的 `prepareGroupPromptSnapshot`；`chain-generate/route.ts` 约 467-565 行；客户端 `packages/client/src/orchestrators/chain-generate.ts` 的 `applyReferenceAudioFiles`（约 335 行）。

主 composer 已基本对齐：图片 N 严格绑定、造型图优先、音色引用、声音分层、动作校准、风格锁、无文字/水印、资产数量拆组均已存在。CS “先整合并持久化 prompt，再允许生成；自定义 prompt 过期则 409”比 app1 更适合 C/S 的可恢复任务链。

本轮已修：

- 资产 lookup 会同时匹配 `metadata.sourceNames`，场景氛围查找也复用同一 alias 逻辑。
- 音色分离 `promptAudioUrls` 与 client bare filenames；仅 manifest 可读的裸 wav 下发客户端，避免 `/api/...` 被 `readPresetVoice` 拒绝。
- `contextHash` 只包含本组实际解析到的资产、造型表条目和最终选择的造型，并覆盖 prompt 真正消费的字段；不再因无关角色改衣服使全剧 prompt 过期，也不会因 mood/intExt/sourceNames 等变化漏判。
- 4 人上限只统计真正 CHARACTER，网格 LOCATION/PROP 仍受总 9 图上限约束。

仍待修的是彩铅模式：`chain-generate/route.ts` 约 538 行当前追加 `colored pencil animation...`，而 app1 在 worker 约 1045/1522 行追加 `PENCIL_PAINTING_RESTORATION_PROMPT`。完整修复必须同时做到：

1. 客户端先为参与镜头的角色生成并持久化彩铅缓存；
2. 组参考图确实选中这些缓存；
3. 最终 prompt 要求恢复项目锁定的写实/目标风格；
4. 缺缓存时明确拒绝或关闭该模式，不能静默用普通图却追加“还原”提示。

### 7. 长视频转剧本

对照位置：

- app1：`src/core/video/long-video-prompt.ts` 的 `buildOutlinePrompt`、`buildFullScriptPrompt`、`buildMergeScriptPrompt`、`buildRewriteFromOutlinePrompt`（约 32/228/493/635 行）。
- CS：`packages/shared/src/long-video-prompt.ts` 同名函数（约 36/232/492/629 行）。

`buildOutlinePrompt` 基本对齐。主要缺口在 `buildRewriteFromOutlinePrompt`：app1 约 654-716 行已增加六种推进/兑现类型、连续三集不得重复、反“众嘲→亮身份→全跪”、反固定电话/消息钩子、钩子类型轮换，以及严格元文本禁令；CS 约 648-706 行仍是旧版通用规则。

建议优先同步 rewrite 和 parser，再处理未走主链的 Full/Merge 动态集数。app1 Full/Merge 会按 `videoDurationSec / 90s` 推导并钳制集数范围；CS 仍固定 `50~70`。同时要明确：视频转写的商业长剧“最低 50 集”与原创剧本“保持原集标记/冻结集数”是两种业务，不应共用一个强制集数策略。

## 不应机械照搬 app1 的地方

1. **不要恢复双语括号资产名。** CS 的目标语言唯一展示名 + `sourceNames` 更干净；应补齐 alias 消费链。
2. **不要复制 app1 全局禁眼镜/蓝绿眼。** 这会改人物设定；改成剧情条件负面词。
3. **不要复制 app1 分镜巨型单块 prompt。** 它包含历史硬编码 90 秒及互相叠加的规则；模块化移植高价值规则，保留 CS 的本地化时长预算。
4. **不要让 LLM 重抄原文作为拆集真相。** CS 当前冻结哈希 + 无损服务器切片方向更可靠。
5. **不要退回“生成时临时拼 prompt”。** CS 的 prompt snapshot、过期检测、生成前持久化更适合客户端断线/重试。
6. **不要把整剧资产富 schema 一次性塞给模型。** 长剧用清单首遍 + 分批丰富字段，质量和完整性更可验收。

## 回归与质量验收建议

最低自动化回归：

- 原剧拆集：显式集标记、无标记、空白差异、LLM 漏文/改文、集数不匹配，最终拼接必须逐字符等于冻结原文。
- 资产生图：人脸道具无参考图必须阻止；有参考图时 prompt 不含“不得出现人物”；普通 PROP 仍禁止人物。
- 变体：costume 与 period 分别验证身份锁允许维度，生成 revision 与 costumeKey 刷新后仍可恢复。
- 分镜别名：英文原文 `sourceNames` 能归一到中文 PROP/LOCATION 展示名，最终镜头组能选到正确图片。
- 灵石 parser：包含“本次只生成/续写计划/As an AI”夹杂文本时，元文本不得进入任何 scene content。
- 长视频质量夹具：至少检查连续三集推进类型/钩子类型不重复，禁止群体统一跪舔模板。
- 镜头组：空/有音色、裸 wav/HTTP 音频、无关资产变化、相关 mood/intExt/造型变化、网格环境/道具 + 4 角色边界。
- 彩铅：无缓存拒绝；有缓存时提交的是彩铅参考图，最终 prompt 是“风格还原”而不是“彩铅动画”。

此外建议用三套固定剧本做人审 golden set：中文原创直出、英文海外转编、同一角色跨年龄 period 变体。每次 prompt 改动对比资产覆盖率、未定义资产引用、对白遗漏、镜头重复率和前 10 集钩子重复率，而不只看字符串快照。

## 部署流程只读审计

现有标准流程：

- `deploy.sh [tag]`：本地 web/server build → 本地构建 web/ai-worker 镜像 → 远端保存 `rollback` → 传镜像 → migrate → `docker compose up -d --no-build` → compose 状态与 `/api/health` → 清理旧 tag。
- `phase2-push.sh [tag]`：只推送已在本地构建并确认的镜像，跳过 build。
- `rollback.sh`：把 web/worker 的 `rollback` 重新标记为 latest 并重启；**不回滚数据库迁移**。
- 客户端：`packages/client` 单独 build/package，再由 `scripts/publish-client.sh` 上传安装包并更新版本 manifest。

上线前仍需补的护栏：

1. 涉及管理员项目/剧本集数修复时，部署前单独备份 PostgreSQL 与目标项目 JSON；现有 deploy 不做数据备份。
2. 当前脚本同时切 web/worker。新旧任务 payload/hash/音频字段有契约变化时，应保证双向兼容，或显式 worker-first、验证 worker 后再切 web。
3. `/api/health` 不能证明队列和生成链可用。至少补：prompt prepare、单个轻量任务入队/消费、chain payload、数据库 migration、容器 restart count/OOM、最近错误日志。
4. 回滚只保留单个上一版，且 migration 不回退；新 migration 必须 additive、旧代码可忽略。
5. 音频、网格、本地资产协议若改变 Electron 消费方式，必须同步发布 client，或保留对旧版客户端的兼容字段。

本报告不建议在上述 P1 质量链和回归未完成时仅凭 `/api/health` 直接全量部署。
