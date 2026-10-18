# 镜头连续性 / 提示词 / 资产变体 (Known Issues)
> System-of-record,从 Claude 记忆合并 2026-07-27。Liveness: ✅current · ⚠stale · 📦historical · ⛔rejected
>
> 核验基准:本仓 HEAD = `5f6119f`(2026-07-26 10:12 +0800),工作树有 44 个脏 tracked 文件 +
> `packages/web/app/api/projects/[id]/shots/group-prompt-finalize/`(untracked 目录)+
> `packages/web/test/seedance-narrative-rewrite.test.ts`(untracked)。生产部署与 git commit
> 不绑定——deploy.sh 从工作树直接构建镜像,所以"已部署"≠"已 commit"。

---

## 镜头组座位布局 + 复用门 staleness 修复 [✅]
**Symptom:** 跨镜头组站位乱(4945 开车戏司机位不同组不一样);资产/运镜改了重新生成,出来的还是旧视频。
**Root cause:** 三件事的根因都收敛到 chain-generate route 的复用门:① 座位描写被 LLM 写进 `SceneInfo.content` 自由文本,代码读不到;② 复用门 `整组全COMPLETED同URL` 就跳过重生成,且**早于** `readStoredGroupPrompt` 的 staleness 校验 → 改资产/运镜后整集生成(force=false)直接返回旧视频;③ `VideoEditor.tsx` 读不存在的 `shot.cameraMovement` 列永远显示"未标注运镜"。
**Rule / fix:**
- `SceneInfo.spatialLayout?` 新字段;`script-prompt.ts` 加「座位布局：」规则(zh/en);`parseScriptResult` 正则提取并从 content 剔除。`buildSceneSpatialLayoutMap(scriptData)`(group-prompt-snapshot.ts)按 `extractBaseSceneId` 归一化 key(S3-1→S3)。
- `combineGroupPrompts`(group-preview.ts)在「角色：」行后 emit `座位布局：…；跨镜保持位置不变。`(无则省略)。**老集需重新分析那集才会有 spatialLayout**(analyze 只写 scriptData 不动 shots,安全)。
- 复用门修复:`readStoredGroupPrompt`(纯函数,无 await/副作用)前移到门前 + 门加 `storedPrompt.status==='READY'`,抽 `shouldReuseGroupVideo` 纯函数到 group-prompt-snapshot.ts 便测。`contextHash` 已含资产 imageUrl(`assetPromptFingerprint`)+ 运镜(`metadata.storyboardTable.cameraMovement` 经 `promptContextMetadata`)。一次修好资产+运镜+位置三件事。
- **三路由 hash 一致性(关键)**:`chain-generate` / `group-prompts/prepare` / `shots/generate-group-preview` 三个持久化 hash 的路由都要传同一个 `sceneSpatialLayoutMap`(都从 `episode.scriptData` 建);空 map 与不传都归一化为 null。
- **座位布局角色名→图片N**(续,commit 63b8078):座位布局由 LLM 用角色名写,但组提示词要按火山 Seedance 2.0 官方格式用**裸 `图片N`**(无容器/括号)。`convertCharacterNamesToImageRefs(spatialLayout, characterImageNumber)`(group-preview.ts 纯函数)按本组「角色名→图片N」映射替换(保留位置括号 → `图片1(左前·驾驶位)`);该组没参考图的角色保留原名。经 PDF《火山方舟文档指南》p386-394 核实。
**Live gotcha:** `VideoEditor.tsx` 已修(内联 `readCameraMovement` 读 `metadata.storyboardTable.cameraMovement`);**`shot.shotSize` 同病未动**(StoryboardStage 模块私有 `getCameraMovementValue` 不可导入,故内联)。`montageType` 是死列(没人写没人读)。
**Refs:** `packages/web/lib/group-prompt-snapshot.ts:buildSceneSpatialLayoutMap, shouldReuseGroupVideo`, `packages/server/src/domain/prompt/group-preview.ts:convertCharacterNamesToImageRefs, '座位布局' 注入行`, `packages/web/app/api/projects/[id]/episodes/[episodeId]/chain-generate/route.ts`, `[[dramaforge-position-layout-staleness-gate]]`
---

## CHARACTER_GRID_REFERENCE_REQUIRED 前置门 + 动态保底 [⚠]
**Symptom:** 链式生成报 `[CHARACTER_GRID_REFERENCE_REQUIRED] 人物镜头缺少可用角色资产图，无法生成稀疏网格：<角色>`,但被截断的角色其实有图,只是槽位超限。
**Root cause:** chain-generate route 的 **HTTP 400 前置门禁(不入 render_jobs 表,查 DB 查不到)**,两段逻辑自相矛盾:`prepareGroupPromptSnapshot` 把 CHARACTER 参考图**硬截断**;route 的 `missingCharacterImages` 校验要求镜头声明的**所有**角色都在被截断后的 assetRefs 里 → 第 5+ 个角色必然 missing → 400 阻断整组。「被截断」被误判成「缺资产图」。
**Rule / fix:**
- `group-prompt-snapshot.ts` **动态保底分配**:角色上限 = `9 − 环境保底(≥1) − 物品保底(≥1)`;环境(LOCATION) 优先于物品(PROP);末帧不保底(ark.ts slice 兜底,排末位)。`assetRefs` 与 `characterImageUrls+imageUrls` 严格同序(图片N 不漂移,有专门单测)。
- route.ts 校验改成**独立判断**「角色是否有可用图」:复用 dead code `buildReferenceAssetIndex`(重构为接收已加载 `assets`)+ `normalizeCharName`。被截断但有图的角色不再误报;**真无图仍报 CHARACTER_GRID_REFERENCE_REQUIRED**。
- **常量值漂移注意(2026-07-25 被 [[dramaforge-reduce-continuity-errors]] 覆盖)**:本修复初版把 `MAX_REFERENCE_CHARACTERS` 4→**7**(deploy tag `5127850`,2026-07-24);次日对齐 app1 防双胞胎又改回 **4**(seedance-helpers.ts:39 当前值)。动态保底机制仍活,只是上限阈值回到 4。**未来"镜像 app1"审计看到 7→4 别当回归改回来。**
**Live gotcha:** ⚠ **本条 memory 的"7"已 stale**——当前 `MAX_REFERENCE_CHARACTERS = 4`([[dramaforge-reduce-continuity-errors]] 的对齐 app1 决策覆盖)。5+ 角色场景仍会被拆成更多子组(由 prepare cap 截断 + provider slice 兜底),不会在路由层硬阻断,但双胞胎风险靠拆组缓解。4945 案例的同名用户 render_jobs 另有 ark `PROVIDER_CONTENT_REJECTED`(真人审核拒图)FAILED,放宽槽位**不解决**它(见 chain-compile-face-lost)。
**Refs:** `packages/web/lib/group-prompt-snapshot.ts:397-399`(动态保底), `packages/web/app/api/projects/[id]/episodes/[episodeId]/chain-generate/route.ts:108 buildReferenceAssetIndex, :419/:517 CHARACTER_GRID_REFERENCE_REQUIRED`, `packages/server/src/domain/prompt/seedance-helpers.ts:39 MAX_REFERENCE_CHARACTERS=4`, `[[dramaforge-grid-ref-required-charcap-fix]]` `[[dramaforge-reduce-continuity-errors]]`
---

## 时间锁(时段/光照跨镜一致)dramaforge 独建 [✅]
**Symptom:** 一集里同一场景不同组时段乱跳(早午晚切),除非剧本明确换场换时。
**Root cause:** app1 **没有任何时间锁**(extractSceneAtmosphere 只 per-group 推导 lightSource/mainColor,不锁定、不跨镜约束),无法直接镜像。按 dramaforge 独建原则照搬已有的 spatialLayout 文本路径(不是 blocking-image 图像路径)。**关键设计**:锚点必须场景级(`scene.time`),不能用 per-group 推导值——同场景不同组可能推不同值→锁自己会闪烁。
**Rule / fix:** `scene.time` 是 analyzing 从场景头 `[地点·时间·内外景]` 解析的**场景级**字段(日/夜/晨/昏/午/黄昏/次日凌晨),全场景恒定,**每个场景都有**(非 spatialLayout 那种可选),无需 re-analyze、老集即生效。
- `buildSceneTimeOfDayMap(scriptData)` 读 `scenes[*].time`(跳过空);normalize(空 map=null 保三路由 hash 一致);传入 `combineGroupPrompts` + 进 `contextHash`(时段变→READY→STALE 重生成)。
- `combineGroupPrompts`(group-preview.ts:1697)挨着"座位布局:跨镜保持位置不变"注入:`时段光照：${time}。本场景所有镜头统一为此时段：主光源方向、色温与明暗对比保持一致，不要在镜头间切换早/午/晚、翻转光线方向或改变冷暖色调，除非剧本明确写了时间或场景转换。`
- 三路由(chain-generate / group-prompts/prepare / shots/generate-group-preview)各加 `buildSceneTimeOfDayMap(episode.scriptData)` build + 传 `sceneTimeOfDayMap,`。
**Live gotcha:** 与 [[dramaforge-scene-blocking-image]] 的视觉时间锚点(scene-prompt.ts:36 blocking-image prompt embeds `scene.time`)是**互补**:blocking-image 是图像版,本锁是文本版,两者都基于 `scene.time`。与 [[dramaforge-reduce-continuity-errors]] 的 SEEDANCE_CREATION_CONTEXT(全局限流措辞)不同——后者是通用 anti-slop,本锁是场景级硬不变量。scene.time 措辞五花八门时(LLM 可能写"白天/上午/子夜")原样注入,模型应能懂。**未做真 key 冒烟**(待验证同场景多组时段一致)。
**Refs:** `packages/web/lib/group-prompt-snapshot.ts:258 buildSceneTimeOfDayMap`, `packages/server/src/domain/prompt/group-preview.ts:1697 '时段光照' 注入行`, `[[dramaforge-scene-time-of-day-lock]]`
---

## 上一组尾帧衔接提示词(prevLastFrameHint 不再死解构)[✅]
**Symptom:** chain-generate strict 串行下,组 i 完成后 `extractLastFrame`+`gridOverlay`→base64 喂给组 i+1 当参考图,**但模型不会用**(光送进去而已)。
**Root cause:** ark.ts(:94-110)把末帧拼到参考图数组**最后一张**(`allReferenceImageUrls=[...charRefs,...sceneRefs,...imageUrls,...lastFrameUrls,...chainedFrameUrls].slice(0,9)`)。`combineGroupPrompts`(group-preview.ts)**解构了 `prevLastFrameHint` 选项却从没用它 push 任何行**——只有声明/默认值/透传,解构块没它。所以提示词零说明,模型不知道最后一张是尾帧、该怎么用。
**Rule / fix:** 解构块补 `prevLastFrameHint = false,`;在「## 开场连续性锁定」段(主体开场状态之后)按 hint 注入:
> 首尾衔接：本组首镜紧接上一镜头组的末帧（即本组参考图的最后一张），继承其场景状态、人物站位与主光方向作为起点，使两组画面无缝衔接；该末帧仅用于衔接参考，不得照搬其画面内容，也不得把其中的角色当作新增人物复制进画面。

比 app1 改进:①点名「参考图最后一张」=末帧(ark.ts 保证位置恒定);②加用法约束(防双胞胎+防复制)。各路由按**位置型**设 hint:`parallelMode === 'strict' && (hasPreviousContext || groupIndex > 0)`(chain-generate:501 / prepare:99 / generate-group-preview:155 / finalize:142)。
**Live gotcha:** **已知次要 desync**:hint 不是"图确实在手"——极少数 `extractLastFrame` 失败时(referenceImageBase64 不附,chain-generate.ts:784)图没附但提示词说衔接,会让「最后一张」误指成道具。但 extractLastFrame 已有 3 段降级([[dramaforge-cloud-deploy-state]] 续59 1.1.12),失败很罕见;措辞「仅衔接参考」限损害。**ark.ts slice(0,9) 旁注**:若组参考图>9 张,末帧(在数组最后)会被截断丢弃但提示词仍说衔接——分组器 `splitShotsByAssetLimit` 本应控≤9;app1 同样。彻底同步需把提示词挪到运行时按帧存在重建=大重构,不值。
**Refs:** `packages/server/src/domain/prompt/group-preview.ts:139, :1485, :1708-1717`, `packages/web/app/api/projects/[id]/episodes/[episodeId]/chain-generate/route.ts:501`, `[[dramaforge-prevframe-continuity-prompt]]`
---

## 场景站位图(blocking image)视觉锁跨组空间 [✅]
**Symptom:** 跨镜头组空间漂移(4945 开车戏司机位乱换)。文字「座位布局→图片N」是文本版缓解,加**视觉版**:每含座位布局的场景生一张站位图喂进 ≤9 参考图,锁跨组地理。
**Root cause:** 火山官方原则「空间关系展示比描述省事」——文本座位的视觉约束力不足。
**Rule / fix:** 用户 4 决策:① 图里人物=**无脸轮廓**(躲 Seedance>4人/双胞胎上限 + ark 真人审核);② 粒度=**每场景1张**(同场景各组共用);③ 生图时机=**手动·每场景按钮**(镜像资产生图流);④ 名额=**烘焙道具·替换普通道具**(有站位图的场景普通 PROP 参考省掉,只留标 `metadata.standaloneReference` 的怕变形道具)。
- **存储(关键)**:`scriptData.sceneBlockingImages: Record<baseSceneId, BlockingImageRecord>` **顶层兄弟 map**(被 analyze `...existingScriptData` spread 保留);**不能挂 SceneInfo**(re-analyze 整体替换 scenes 数组会丢)。镜像 costumeMap 先例。
- `group-prompt-snapshot.ts:305 buildSceneBlockingImageMap(scriptData, currentSpatialLayoutByKey)` 只返 COMMITTED + `sourceSpatialLayout===当前`(re-analyze 改布局→空=安全降级);`prepareGroupPromptSnapshot` 有则注入 `{kind:'BLOCKING'}` ref 进场景通道(保留名额 blockingReserved)+ 抑制非 standalone PROP。blocking url 已进 `references`→contextHash 自动 STALE。
- `group-preview.ts:59` `GroupPromptReferenceBinding.kind` 加 `'BLOCKING'`;`:1630` forEach BLOCKING 分支发「场景空间布局参考 图片N:…无脸占位…身份以角色参考图为准」。
- `scene-prompt.ts:29 buildBlockingImagePrompt(scene, spatialLayout, propNames, {styleLock})`——写实定场+无脸剪影占位+烘焙道具+无脸硬约束。路由层算 styleLock(`getProjectArtStylePreset`)+sanitize。
- 路由 `scenes/[sceneId]/blocking-image/route.ts`:POST 同步 callAI ark/doubao-seedream 生图(余额门+2K 16:9)+写 GENERATING 记录+返回 providerUrl;PUT 客户端下回 sf-asset:// 后翻 COMMITTED(version 服务端自增)。镜像资产生图两阶段。
- `AnalyzingStage.tsx`:场景卡片(仅 spatialLayout 存在)加「生成站位图」按钮;缩略图+过期标记。`AssetDesignStage.tsx`:PROP 加「独立参考·怕变形」toggle 写 `metadata.standaloneReference`。
**Live gotcha:** **运行时冒烟未做**(本地无 key,deferred)——真生成验证无脸图是否真锁跨组空间 + Seedance 是否把无脸人形当真人渲染(靠角色参考图+引用行缓解)。9 张压力:7 角色+站位图+1 环境+standalone 道具;超 9 现有保留算法截断(道具最后)。moderation rewriter 可能动新引用行(低风险,观察)。re-analyze 改布局会让站位图过期但不删(返回空 map 安全降级)。
**Refs:** `packages/web/lib/group-prompt-snapshot.ts:280 BlockingImageRecord, :305 buildSceneBlockingImageMap, :421 BLOCKING ref`, `packages/server/src/domain/prompt/scene-prompt.ts:29 buildBlockingImagePrompt`, `packages/server/src/domain/prompt/group-preview.ts:59, :1630`, `packages/web/app/api/projects/[id]/episodes/[episodeId]/scenes/[sceneId]/blocking-image/route.ts`, `[[dramaforge-scene-blocking-image]]`
---

## 减少出片穿帮三连(分组贪婪/反双胞胎/角色上限7→4)[✅]
**Symptom:** 跨组不一致(穿帮),组数偏多没压满 15s,角色多视图设计稿被模型当多人画(双胞胎)。
**Root cause:** 三件同源指令的根因各异:① 分组阶段3 有 `MIN_GROUP_SHOTS=4` 门槛,两个**都 ≥4 镜但合计 ≤15s** 的相邻组不合→组数偏多;② 角色参考图是多角度设计稿(整张直送 Seedance 无裁剪)模型易把多视图读成多个人,提示词零说明;③ 角色上限 7 比火山官方建议>4 易双胞胎。
**Rule / fix:**
- **A. 分组贪婪压满 15s(对 app1 授权偏离)**:`computeGroupsForChain` 阶段3 删 `MIN_GROUP_SHOTS=4` 门槛 + 删常量。相邻组只要合计 ≤15s 即贪婪合并,15s 硬上限不动。**app1 对照(`D:\app1\src\core\ai\grouping.ts`)也有这门槛,app1 故意留=尊重 groupIndex 分组意图**。dramaforge 去门槛是用户明确要"少分组"的授权行为变更(和站位图同类),不是回归。改了三处:`group-preview.ts`(server 权威)+ `ProductionStage.tsx`(inline 副本必须同步)+ `group-prompt-snapshot.test.ts`(+2 用例)。
- **B. 反双胞胎提示词(纯增强,app1 无)**:`combineGroupPrompts`(group-preview.ts:1656)在资产参考图引用块后、`characterOrder.length>0` 时加一行:声明角色参考图是"同一人正/侧/背多视图设计稿",画面每角色只出现一个真人,严禁把多视角当多人复制、严禁重复角色/双胞胎。根因仍在(资产图整张直送无裁剪),用户选"仅提示词约束(轻)"。
- **C. 角色上限 7→4 对齐 app1(用户纠正后定案)**:初始建议是"保持 7",用户 2026-07-25 纠正("app1 是已经测试过的方案")= 直接对齐 app1 的 4(不试未验证的中间值 5)。**两处行为常量必须同步改**(否则服务器/路由漂移):① `seedance-helpers.ts:39 MAX_REFERENCE_CHARACTERS 7→4`(server 域);② `chain-generate/route.ts:82 MAX_CHARACTER_REFERENCES 7→4`(web route 层**独立本地镜像副本**,不 import 服务器常量,注释明写"对齐 MAX_REFERENCE_CHARACTERS"——漏改必漂移)。
**Live gotcha:** **C 覆盖了 [[dramaforge-grid-ref-required-charcap-fix]] 的常量改动**(那条 2026-07-24 把值改 7,本条 2026-07-25 又改回 4);动态保底机制([[dramaforge-grid-ref-required-charcap-fix]])仍活,只是阈值回 4。**取舍(用户接受)**:5+ 角色场景会被拆成更多子组(app1 同款代价)。charcap-fix 不破:单镜引用 >4 角色无法拆组时,由 prepare cap 截断 + provider slice 兜底,**不**在路由层硬阻断。**`ProductionStage.tsx` inline `splitShotsByAssetLimit` 只按图片数(9)拆、不建模角色拆分**(既有分歧,本次不动,多人场景显示组数可能偏少)。**未做真生成冒烟**(deferred)。
**Refs:** `packages/server/src/domain/prompt/group-preview.ts:1656 反双胞胎行, :1653-1654 注释, computeGroupsForChain 阶段3`, `packages/server/src/domain/prompt/seedance-helpers.ts:39 MAX_REFERENCE_CHARACTERS=4`, `packages/web/app/api/projects/[id]/episodes/[episodeId]/chain-generate/route.ts:82 MAX_CHARACTER_REFERENCES=4`, `packages/web/app/workspace/[projectId]/components/ProductionStage.tsx inline 副本`, `[[dramaforge-reduce-continuity-errors]]`
---

## 造型变体替换图片守卫精确到变体 + 死任务超时清理 [✅]
**Symptom:** 造型变体(非默认底图)想替换图片,toast 一直「该资产图片正在处理中…换不了」。
**Root cause:** 一个变体卡死(DB 永远 PENDING/RUNNING)→ `AssetDesignStage` restore effect 每次进页把卡死任务重加进 `pendingTasks` → `generatingIds`(按 assetId 派生)锁**整资产** → `handleUploadImage` 守卫 `generatingIds.has(assetId)` 挡掉该资产**所有变体**上传。即一个变体卡死,同资产其他变体都换不了。卡死的本地生成锁存 `localStorage workspace_generation_locks_v1`(STALE 3 天),所以刷新也不解。
**Rule / fix:**
- (A) **守卫精确到变体**:`handleUploadImage` 改查 `pendingImageKeys.has(\`${assetId}:${costumeKey||'default'}\`)`(变体粒度,只挡「该变体正在生成」,不挡同资产其他变体/上传)。
- (B) **死任务超时清理**:restore effect 加 `STALE_TASK_MS = 15 * 60 * 1000`(15min),锁龄超 15min 视为死任务,`clearGenerationLockByTaskId`+`untrackTaskId` 清掉。
**Live gotcha:** **立解(不等部署)**:F12 控制台 `localStorage.removeItem('workspace_generation_locks_v1')` + 刷新。变体图在 `asset_image_revisions` 表(versioned, status GENERATING/GENERATED/COMMITTED/FAILED);`commitAssetImageRevision` 把非默认变体图写到 `costumes[idx].imageUrl`;`mergeCostumeMetadataPreservingImages` 在 metadata PATCH 时保留图指针。两阶段提交:client `saveLocalAsset`(每次 `newClipId` 新 UUID,无 key 复用/缓存)→ `sf-asset://` → POST /images → `commitAssetImageRevision`。
**Refs:** `packages/web/app/workspace/[projectId]/components/AssetDesignStage.tsx:304 STALE_TASK_MS=15min, :390 pendingImageKeys, :809 守卫`, `packages/web/hooks/useGenerationLock.ts:34 STORAGE_KEY, :132 clearGenerationLockByTaskId`, `[[dramaforge-variant-image-replace-lock]]`
---

## 镜头组提示词画面信息去重(parseCompositeVisual)[✅]
**Symptom:** 4928 实际组提示词同一画面信息出现 4 次 + `主体开场状态` 混入 `[voice:]`。
**Root cause:** dramaforge 落库 `generate-storyboard/route.ts` **只存 `shotSize/cameraAngle/cameraMovement/action/soundCue`**,把 `visualContent/globalPrompt/detailEnhancement/timecodePrompt/voiceContent` 干净列**全丢了**。于是 `buildShotNarrative`(group-preview.ts)的 fallback 全读同一个 `shot.visualPrompt`(完整复合体 `【首】\n[MM:SS],景别,机位,运镜,[主体]+…,[voice:…]\n【落】`),整个 dump 进 `画面:` 行,又在 `当前动作/镜头/首末` 重复片段。app1 没这问题——app1 存干净分列。**认知反转:app1 也是平铺带标签行(当前动作/画面/镜头/落点),不是融合一段;dramaforge 该对齐这个结构,别推平。**
**Rule / fix:**
- 新 `parseCompositeVisual(rawSource)`(group-preview.ts:1271):复合体解析一次 → `renderBody`(画面,时间码行去[MM:SS]+[voice])+ `首末`(行外【】bracket)+ `voice`。无时间码行(干净 fixture)→ renderBody=cleanVisualPrompt(原文),行为不变(保测试绿)。
- `镜头` 行运镜**只用 storyboard 列**,删 `fields[2]` split 覆盖(正文含逗号 → fields[2] 错位吃进正文,4928 实况)。
- `lockingParts`(combineGroupPrompts:1592)加 `.filter(!/^(voice|audio|vo|os|音)/i)` → 修 `主体开场状态：[主角]+[画面中央]+[voice: distant horns…]`(LLM 主体标签<4个时 voice 滑进前4)。
**Live gotcha:** **残留(未完美)**:画面正文开头仍带景别/机位/运镜(与镜头行轻度重叠)——正文含逗号无法可靠按字段切剥前缀。彻底解=Option A(落库存干净 visualContent 列像 app1),deferred。`落点`/`情绪外化`保留(app1 也有/dramaforge 增强)。只对新生成/force-regenerate 组生效(缓存 READY 复用旧提示词)。
**Refs:** `packages/server/src/domain/prompt/group-preview.ts:1271 parseCompositeVisual, :1334 调用, :1592 lockingParts filter`, `[[dramaforge-group-prompt-composite-dedup]]`
---

## 道具/环境变体(dramaforge 独建偏离 app1)[✅]
**Symptom:** 用户要道具(PROP)和环境(LOCATION)也能像角色 costume 那样有变体(剑在鞘内/出鞘、内景日/夜)。
**Root cause:** app1 变体**只有角色 costume**(走 AI 提取的 `costumeMap`,character 键)。dramaforge 要支持非角色变体必须偏离"镜像 app1"原则——用户明确要做,接受。
**Rule / fix:** 手动 MVP 复用 `assets.costumes` JSONB + `CostumeVariant` shape(底层 kind 无关)。**关键简化**:不走 costumeMap(那是 AI 从 analyze 正则解析、character 键)。变体自身 `coverageScenes` 字段在生成期按场景选——用户在变体编辑器手动加变体图 + 填 coverageScenes。
- `group-preview.ts:367 selectVariantByScene(asset, shotSceneId)`(coverageScenes 经 extractBaseSceneId 归一匹配,返变体 URL);`collectNonCharacter`(:595)内 `const shotSceneId = readShotSceneId(shot)`(**注意:外层 503 的 shotSceneId 在 characters 循环内,collectNonCharacter 看不到,必须内部重算**)+ `variantUrl ?? selectAssetImage(asset)`(变体赢过 pencil,对齐角色 costume)。
- `asset-prompt.ts:1541-1550 buildAssetImagePrompt`:加 `propVariantClauseEn/Zh` + `locationVariantClauseEn/Zh`(isNonDefaultVariant 时注入"同一物体/空间,仅按变体描述改变状态");接在 PROP/LOCATION 4 个 kind 模板尾。
- `AssetDesignStage.tsx:2323` 闸门放宽含 PROP/LOCATION;**空态修复**(`costumes.length===0 && kind==="CHARACTER"` 只允许 CHARACTER 空态预填——PROP/LOCATION 无 extraction 预填,空时也要露"+ 新增"入口,不修则永远加不了第一个变体);variantType select 仅 CHARACTER 显示;description placeholder 按 kind(状态/时段)。
**Live gotcha:** **consistencyPrompt 未改**(死代码 for 变体)——`handleVariantGenerate` 传 `onGenerateImage(id, undefined, ...)` 无参考图,变体是 text2img 靠 prompt 子句锁身份(角色 costume 变体也同此路径,consistencyPrompt 对变体是死代码)。**deferred**:AI 自动提取道具/环境变体(改 analyze prompt+script-prompt 正则+3 路由+extraction);LOCATION 日/夜变体与"时段光照文字锁+场景站位图"深度整合(目前互补各管各)。**⚠ 偏离 app1**(app1 变体只有 costume),未来"镜像 app1"审计看到别砍。
**Refs:** `packages/server/src/domain/prompt/group-preview.ts:367 selectVariantByScene, :595 collectNonCharacter 调用`, `packages/server/src/domain/prompt/asset-prompt.ts:1514 isNonDefaultVariant, :1541-1550 变体子句`, `packages/web/app/workspace/[projectId]/components/AssetDesignStage.tsx:2323, :3051 闸门`, `[[dramaforge-prop-location-variants]]`
---

## 组提示词审核锁定(LLM 最终提示词认可后永不重写)[⚠]
**Symptom:** 用户要"LLM 最终组提示词先展示给用户看、认可再用、认可后生产只用它不反复调 LLM;每组下挂视频片段方便核对"。
**Root cause:** 组 prompt 挂首镜 `shots.metadata` JSONB;LLM 重写唯一入口 `chain-generate/route.ts:563` 门 `status!=='READY'`;提示词正文卡片上不可见(藏生成弹窗);渐进回传已实现但视频散在平铺镜头列表、不挂组卡片。只靠 READY 缓存不够(数据变就 STALE 重写)——用户原话"不能反复引用 LLM 生成"+"只用这个提示词"=要硬保证。
**Rule / fix(4 件):**
1. **数据模型(无迁移)**:新增 metadata 键 `seedanceGroupPromptApproved`(bool)+`...ApprovedAt`。`groupPromptMetadata()`(group-prompt-snapshot.ts:561)增 `approved` 参(**undefined=保留 existing 防 prepare/preview 旁路写回误清锁定 / true=锁 / false=显式解除**);`readStoredGroupPrompt()`(:512)返 approved。
2. **finalize 端点(新)** `POST /api/projects/[id]/shots/group-prompt-finalize`:`prepareGroupPromptSnapshot`→`requireBalanceOrFail`→`rewriteGroupPromptForModeration`(独立 billingTaskId)→落库(rewritten=true,approved=false,READY)→返 finalPrompt。**已 approved 且非 force→直接返锁定提示词不重跑不花钱**;force→重跑并重置 approved=false。补 `appendSeedanceMotionCalibration` 使 READY 复用路径仍含 motion 段。**URL 用 shotIds-in-body**(镜像 generate-group-preview),非 [firstShotId] 路径。
3. **生产门**(chain-generate/route.ts:~552):`if(status!=='READY' && !approved)`——approved 锁定的组即使 STALE 也跳过 LLM 重写;executablePrompt 三元加 approved 分支用锁定值。**不动 `shouldReuseGroupVideo`**(approved 只跳文本重写,不短路视频复用否则复用旧视频)。generate-group-preview/route.ts 加 approved 守卫。
4. **前端组卡片**(ProductionStage.tsx 组卡片末尾):审核区三态(未生成→🔍生成 / 已生成未认可→✓认可锁定+重新生成 / 已认可→🔒+STALE⚠过期+重新生成)+**视频磁贴**(groupShots COMPLETED 的 currentMaterialUrl,hover-play,点击 ZoomViewer 放大)。
**Live gotcha:** ⚠ **未部署/未冒烟**(本地无 key):finalize 端点是 **untracked 目录**(`packages/web/app/api/projects/[id]/shots/group-prompt-finalize/`),ProductionStage.tsx/group-prompt-snapshot.ts/chain-generate route.ts 改动在**脏 tracked 文件**未 commit。**只对新生成/新认可组生效**(存量无 approved 键走老路)。闭环语义:finalize 后(READY/未认可)→生产跳重写用刚展示 prompt;认可后(approved)→永远跳重写即使 STALE;数据变+未认可(STALE)→照常重写(向后兼容)。**未认可仍可直接点"开始生成"走老路(不强制阻断,保留逃生口)**。
**Refs:** `packages/web/app/api/projects/[id]/shots/group-prompt-finalize/route.ts` (untracked), `packages/web/lib/group-prompt-snapshot.ts:512 readStoredGroupPrompt, :561 groupPromptMetadata approved 三态`, `packages/web/app/api/projects/[id]/episodes/[episodeId]/chain-generate/route.ts:~552 approved 门`, `packages/web/app/workspace/[projectId]/components/ProductionStage.tsx:282 buildApproveGroupPromptMetadata, :1928 finalizeGroupPrompt, :3838 审核区`, `[[dramaforge-group-prompt-review-lock]]`
---

## LLM 重写硬结构守卫(assertRewriteStructurePreserved)[⚠]
**Symptom:** 用户担忧"LLM 重写不能破坏镜头组结构与基准内容"。
**Root cause:** `rewriteGroupPromptForModeration`(web/lib/seedance-narrative-rewrite.ts)的图片N引用已有 `validateSavedPromptAssetRefs` 硬校验(改坏降级),但**时间码/分镜结构/衔接段只靠 system prompt 规则口头约束,无代码校验**;且**规则4 把"首尾衔接"列为可删元信息**——与跨组末帧衔接提示词([[dramaforge-prevframe-continuity-prompt]])直接冲突,会被洗掉。
**Rule / fix(两件一起做才名副其实):**
1. **改 REWRITE_SYSTEM 规则**:规则1 扩保护范围(时间码 [MM:SS-MM:SS] 的**值+数量**、分镜 Shot 结构与顺序、`## 开场连续性锁定`整段含主体开场状态+首尾衔接);规则4 摘掉"首尾衔接"出可删列表,明示开场连续性锁定是**承重衔接指令非元信息**不得删改。
2. **新 `assertRewriteStructurePreserved` 硬守卫**(seedance-narrative-rewrite.ts:78,纯函数 exported 供单测):重写后查①时间码数量与每个值不变(防丢镜头/并镜头/改时长)②承重标记(`主体开场状态`/`首尾衔接`)若原文存在不得被删;**任一不过 throw → 调用方 catch 降级原 prompt**。接入点:引用校验后、计费前(seedance-narrative-rewrite.ts:139)。
**Live gotcha:** ⚠ **未部署/未冒烟**:`seedance-narrative-rewrite.ts` 是**脏 tracked 文件**未 commit,`seedance-narrative-rewrite.test.ts` 是 **untracked**。**兜底链路不变**:校验不过→降级原 prompt,不阻断主链路(沿用既有 try/catch)。**只对新生成组生效**(READY 缓存命中跳过重写,不重复花钱)。文件头安全网注释更新为4条。
**Refs:** `packages/web/lib/seedance-narrative-rewrite.ts:45 规则1, :48 规则4, :78 assertRewriteStructurePreserved, :139 接入点`, `packages/web/test/seedance-narrative-rewrite.test.ts` (untracked), `[[dramaforge-rewrite-structure-guard]]`

**生产观察(2026-08-01 11:0x CST,web image 2155da4,30min 窗口):** 4 次 LLM 重写降级——组12(时间码 1→2)、组13(3→6)、组4(2→4)、组9(3→6),数量被改 → 守卫未部署的预期内失效,降级链路按设计兜底(原 prompt 继续生成,不阻断)。部署守卫后此日志应归零,可作为验证信号。
---

## 英文台词缩写撇号截断(you'll / I'm / don't)[⚠]
**Symptom:** 用户报"视频角色没台词了"。查线上 seedanceGroupPrompt:英文对白镜头的 `声音：{角色对白：'台词'}` 被截断——"Kael, you'll definitely awaken as a Priest!" 变成 `{对白：'Kael, you'}` + `<ll definitely awaken...>`(后半截漏进音效)。无缩写的台词完整。
**Root cause:** `packages/server/src/domain/prompt/group-preview.ts` 的 `quotedSpans` 用 `'([^'\n]+)'` 从第一个 `'` 匹配到下一个 `'`,英文缩写里的撇号(you'll/I'm/don't/it's/we'll——硬约束又规定台词全英文,缩写满天飞)被当引号闭合。`splitSoundLayers` 同样按 `'` toggle 引号状态,词中撇号错位。台词在第一个缩写处断、后半截落进 effectLayers。
**Rule / fix(2 处):**
1. `quotedSpans`(:1115)直引号正则改词边界版:`/(?<!\w)'((?:[^'\n]|'(?=\w))*)'(?!\w)/g`(双引号同理)——开闭引号要求前后非字母,词中 `'` 允许出现在引号内。
2. `splitSoundLayers`(:1054)逐字符加 `isContractionApostrophe`(`'` 且前后都是 `\w`,:1065):跳过、不当开闭引号也不当分隔符,防含 ;/+ 的台词被误切。quotePairs 映射不变。
3. 同会话还加 `StoryboardStage` 台词可见:编辑态加"台词（对白）"textarea(绑 `draft.dialogue`,走已有 PATCH→metadata 路径)、展示态加"🎬 台词：{getShotDialogue(shot)}"行。
**Live gotcha:** ⚠ **未部署**:改动在 server `group-preview.ts`(脏 tracked)+ web `StoryboardStage.tsx`(脏 tracked),都未 commit。server 镜像随 web 部署即生效(链路 prompt 由 web chain-generate route 拼,客户端只收成品)。台词格式:有对白镜头出 `声音：{角色对白：'台词'}；<音效>。`,无对白镜头(建场/动作/反应)正确不出声音行。**坑(给未来 Edit 者)**:用 Edit 工具改 group-preview.ts 时 ASCII 直引号会被自动转成中文弯引号(`''`→`''`、正则全弯),文件编译不过;改用 Python 经 bash heredoc(保直引号、不转义)按字节修回,quotePairs 行从文件原样抽取复用(不手敲 Unicode)。heredoc 会吞一层反斜杠:正则 `\w`/`\n` 必须用 `chr(0x5c)+字母` 拼装,不能写 `\\n`。
**Refs:** `packages/server/src/domain/prompt/group-preview.ts:1054 splitSoundLayers + :1065 isContractionApostrophe, :1115 quotedSpans 词边界正则`, `packages/web/app/workspace/[projectId]/components/StoryboardStage.tsx:911 台词 textarea, :1147 🎬 台词行`, `[[dramaforge-dialogue-apostrophe-truncation]]`
---

## 镜头连续性台账(endState 文字状态) [⛔ 否决,勿再做]
**Symptom(曾考虑的方向):** 每镜 endState 文字状态快照(角色位置/姿态/持有道具/门灯开关)注入视频提示词,以提升跨组连续性。
**否决,理由:** 业界/学术(中英文官方+社区+学术)全走**视觉/特征路径**,零来源支持 prompt 文字状态台账:
- NVIDIA Video Storyboarding(arXiv 2412.07750)——多镜头角色一致性 SOTA,机制是 self-attention **特征共享(query injection)**,在模型特征层解决,完全不碰 prompt 文字状态。
- 业界主流三件套:**末帧图链接**(Clip A 末帧 = Clip B 首帧)+ **角色参考图复用** + **时间轴结构化提示词**。
- 搜了 Seedance 官方/知乎/PixVerse/腾讯云/Medium/arXiv,**零来源**提到"在 prompt 写上一镜结束状态"这种文字 continuity ledger。

**根本原因:** endState 是**编剧 skill(拘灵遣将/煮石为粮)的概念,给人/LLM 写剧本用**;视频生成模型是画面生成器不是状态机,对末帧图(视觉条件)的服从 >> 对"门保持关闭"这种文字规则的服从。错移植到视频模型层。

**dramaforge 现状已对齐主流:** 跨组已有末帧图链路(`prevLastFrameHint`+`returnLastFrame`+客户端 `extractLastFrame`+`chainedFrameUrls` 拼参考图末尾)= 业界主流的 end-frame chaining。方向已对。

**若真遇跨组穿帮,正确投入:** 审计末帧图链路是否真生效(strict 模式有没有开 / returnLastFrame 有没有传 / 客户端有没有抽到末帧 / 末帧有没有真拼进下组参考图),**而非加文字台账**。

**边界:** 状态连续性穿帮只是穿帮子类;大头是身份/脸穿帮(见 chain-compile-face-lost / CHARACTER_GRID_REFERENCE_REQUIRED),endState 管不了。同会话打包上线的有效提示词优化(反双胞胎/可见主体锁定/对白安全表/要素锁定/情绪外化/表情约束)见 commit `5f6119f`。
**Refs:** `[[dramaforge-endstate-continuity-ledger-rejected]]`, `[[dramaforge-prevframe-continuity-prompt]]`(尾帧图链路——业界主流对齐)
---

## 附录:Liveness 总表

| Slug | Liveness | 部署载体 / 证据 |
|---|---|---|
| dramaforge-position-layout-staleness-gate | ✅ current | commits 4519381 / ac4d175 / 63b8078 / 0c44f4d |
| dramaforge-grid-ref-required-charcap-fix | ⚠ partial | 机制活(commit 5127850);常量值 7→4 被 reduce-continuity-errors 覆盖 |
| dramaforge-scene-time-of-day-lock | ✅ current | commit 6938f09 |
| dramaforge-prevframe-continuity-prompt | ✅ current | commit 6938f09 |
| dramaforge-scene-blocking-image | ✅ current | commit 6938f09;**运行时冒烟未做** |
| dramaforge-reduce-continuity-errors | ✅ current | commit 6938f09 |
| dramaforge-variant-image-replace-lock | ✅ current | commit 0c44f4d |
| dramaforge-group-prompt-composite-dedup | ✅ current | deploy tag 20260726-prompt-variants-ui(脏 tracked) |
| dramaforge-prop-location-variants | ✅ current | deploy tag 20260726-prompt-variants-ui(脏 tracked) |
| dramaforge-group-prompt-review-lock | ⚠ stale | 未部署:finalize 端点 untracked,ProductionStage/snapshot/chain-generate 在脏 tracked |
| dramaforge-rewrite-structure-guard | ⚠ stale | 未部署:seedance-narrative-rewrite.ts 脏 tracked + test untracked |
| dramaforge-dialogue-apostrophe-truncation | ⚠ stale | 未部署:group-preview.ts + StoryboardStage.tsx 脏 tracked |
| dramaforge-endstate-continuity-ledger-rejected | ⛔ rejected | 无代码,有意不做 |
