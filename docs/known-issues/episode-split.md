# EPISODE_SPLIT 标点美化致拼接超容差误拒 [✅ current]

> 2026-08-10 从记忆 `dramaforge-episode-split-punctuation-align` 迁入(harness doc-gardening 偿还)。
> 记忆瘦身为薄指针,真相源在本档 + 代码。

**Symptom:** EPISODE_SPLIT 让 DeepSeek 把整篇 novelText 逐字复现到各集 JSON `content`,再用「拼接 == 原文(±1.5% 容差)」严格校验。长稿(16 万字中英混排剧本)会**整链回滚、分集失败**——但肉眼看 AI「字一字未改」,只是标点变了。

**Root cause:** `validateSplitAttempt`(`packages/server/src/domain/episode/split-service.ts:318`)的容错只做 `compactWhitespace`(去空白)。LLM 逐字复现长稿时会**自改标点**——实测给英文台词包双引号、多加了 **2422 个 `"`**。引号是**非空白字符**,紧凑比偏移因此超过 1.5% 容差被误拒。字未改 ≠ 拼接相等,标点也计入字符。

**Rule / fix:** commit `fa7fc66`(主)+ `0eb14d9`(95–105 兜底),加「标点无关字流对齐」:
- `wordOnly`(`split-service.ts:248`):去所有非字字符,得到纯字流。
- 当各集 `wordOnly` joined 比例落在 **95–105%** 时,信任 AI 的各集字数边界,用 `reconstructByWordCount`(`split-service.ts:261`)在原文**按字位置切**(`split-service.ts:375`),标点跟原文 → 拼接**恒等原文**。
- AI 若真改了字(字流不等)则**不触发**,回退严格校验,「铁律不破」。

补充:`31631fa` 在分析入口加了「标点逐字保留规则」(防撇号截断传播),前端防线。

**回归守卫:** ⚠ **无自动化单测(红灯)**。运行时守卫 = `validateSplitAttempt` 本身拒绝坏切分并回退严格模式,坏结果不会落库。**建议补** `packages/server/src/domain/episode/split-service.test.ts`:覆盖①纯标点差异应走字流重切②真改字应回退拒绝③拼接恒等原文。

**Live gotcha:**
1. LLM 逐字复现长稿不可靠,会自美化标点(加/改引号)——别信「字没变」。
2. 字未改 ≠ 拼接相等:标点是非空白字符,计入紧凑比。
3. app1 用同协议但只做单向覆盖率 `warn`(<0.95)不校验上界、永不拒绝;**dramaforge 加严了校验,故长稿易失败**——这是 dramaforge 偏离 app1 处之一。

**Refs:**
- `packages/server/src/domain/episode/split-service.ts:248`(wordOnly) `:261`(reconstructByWordCount) `:318`(validateSplitAttempt) `:375`(调用)
- commits: `fa7fc66` `0eb14d9` `31631fa`
- 验证:某客户 第二季 16 万字分集成功 40 集,`splitMode=ai-whitespace-repaired`,拼接逐字 == 冻结剧本。
- 关联:`[[dramaforge-is-app1-cs-migration]]` `[[dramaforge-reduce-continuity-errors]]` `[[dramaforge-analysis-consistency-guard]]`;同主题 known-issue `continuity-prompt.md`。
