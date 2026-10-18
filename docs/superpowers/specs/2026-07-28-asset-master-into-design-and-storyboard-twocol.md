# 资产总表并入资产设定 + 分镜两栏重构 — 设计

> 起草:2026-07-28 · 分支 `feat/cs-ui-slice`
> 触发:部署 `24aca66` 后用户两点反馈:
>   1. 「资产总表应该放在资产设定里面」—— 总表不该是项目页头部的独立入口,应并入资产设定。
>   2. 「分镜设计太拥挤…参考这样调一下布局」+ FrameOS 三栏参考截图。
> 决策:分镜照参考做**两栏**(中栏浏览/右栏编辑),不做左栏诊断面板(无数据)。

---

## 0. 参考来源核验

参考图经视觉模型分析 = 「帧界 FrameOS」分镜工具,**三栏**:
- 顶栏:返回 + 「分镜设计」+ 项目/模式/比例胶囊 + 教程
- 左栏(~12%):分集选择 + 情绪弧线 / 整集诊断(节奏·情绪·时长)
- 中栏(~43%):场景标签 + **片段(SEG)卡片列表**;每卡=序号/状态/时长 + 可展开剧本原文;选中=蓝竖线高亮
- 右栏(~44%):选中片段的 参考资产(角色/物品/环境 卡片) + 视频提示词编辑(场景/场景设计/画面信息/片段数/片段说明 + 各 Shot)

**建模对齐**:参考 SEG ≈ dramaforge group;参考「片段说明 1…2…」≈ group 内各 shot description;参考「场景/场景设计/画面信息」= 组级场景上下文。

**拥挤根源(现状)**:`StoryboardStage` 单列滚动,每个 group 卡片内的镜头表格里,**每个 shot 行点开就是一个巨型行内编辑器**(描述+画面提示词+台词+结构化提示词+约束+风格开关+引用资产重绑+造型),信息爆炸。SEG≈group 的结构化字段在组内每镜重复显示。

---

## 1. Feature A · 资产总表并入资产设定

### 1.1 组件抽取
- 把 `app/workspace/[projectId]/assets/page.tsx` 的矩阵渲染(筛选栏/类型tab/状态条/资产总表视图/按集视图/`AssetMasterCard` 等)抽成可复用组件 `app/workspace/[projectId]/components/AssetMasterPanel.tsx`,接收 `{ projectId }`,自带数据拉取与筛选状态。
- `assets/page.tsx` 改为薄壳:鉴权门 + `<AssetMasterPanel projectId={projectId} />`。(保留路由,直接 URL 可达;避免破坏书签。)

### 1.2 嵌入资产设定
- `AssetDesignStage.tsx` 顶部加视图切换 `[资产设定 | 资产总表]`:`useState<'design'|'master'>('design')`。选中 `master` 时渲染 `<AssetMasterPanel projectId />`,隐藏下方类型 tab 与资产编辑区。
- 切换不卸载已有编辑草稿(视图状态独立)。

### 1.3 入口收敛
- 移除项目工作台头部 `page.tsx:218-230` 的独立「资产总表」链接(并入资产设定后重复)。

### 1.4 影响 / 非影响
- **0 API / 0 schema 改动**(仍 `GET /api/projects/[id]/assets/master`)。
- 不改 `appearance.ts` 派生算法。

---

## 2. Feature B · 分镜两栏重构(中栏浏览 / 右栏编辑)

### 2.1 布局
- 顶栏不变(分镜设计 + 统计 + 目标时长 + 生成分镜/进入生产)。
- 主体由「单列 `overflow-auto`」改为两栏 flex:`中栏(~52%)` + `右栏(~48%)`;`h-full` 撑满,各栏**独立滚动**。
- 空状态/生成中进度条仍跨两栏顶部展示。

### 2.2 中栏(浏览)— group 折叠卡片列表
- 每个 group 一张紧凑卡片:序号(SEG) + 状态徽标(超时/OK) + `N镜·Xs → valids` + 一句概述(首镜描述截断)。
- 点击选中(新增 `selectedGroupId` 状态);选中态=左侧蓝竖线 + 背景略亮(对齐参考)。
- **去掉镜头表格与行内编辑器**。组标题栏的生成/统计信息保留。

### 2.3 右栏(编辑选中组)
- 头:SEG 标题 + `N镜·Xs`。
- **结构化提示词(组级)**:场景 / 场景设计 / 画面信息 textarea(读组内首镜 `metadata.structuredPrompt`,**编辑广播写到组内所有 shot**);下方片段说明(组内各 shot description,只读派生)。
- **组内各 Shot**(可折叠列表):每镜 = 景别/运镜/时长(行头) + 描述/画面提示词/台词(textarea) + 该镜引用资产 chips(角色出镜/说话/造型)。复用现有 `draft`/`setDraft`/`toggleRef`/`toggleSpeaking`/`setStructuredField`/`toggleReferenceStyle` 逻辑,只是宿主从表格行迁到右栏。
- **参考资产组级概览**(只读):组内各 shot `referencedAssets` 的并集,按 角色/物品/环境 分组卡片展示(缩略+名称)。编辑仍在各 Shot 行(数据模型是每镜)。
- 资产约束计数(组级聚合:并集计数 vs 上限)+ 参考视频风格开关(组级,广播)+ `[生成视频]`(组级生成入口,若有)。

### 2.4 组级广播语义
- 场景/场景设计/画面信息、参考视频风格:这些是**组共享场景上下文**,编辑后写组内所有 shot 的对应 metadata 字段。当前每镜重复存储属 AI 冗余;广播消除冗余。读时取首镜值。
- 片段说明 / 描述 / 画面提示词 / 台词 / 引用资产:仍**每镜独立**,不广播。

### 2.5 状态迁移
- 现有 `editingShotId`(单镜行内编辑门)→ 替换为 `selectedGroupId`(选中组)+ 组内展开的 shot 由右栏列表自身管理。
- `draft`/`setDraft` 模型不变:右栏编辑某镜时,把该镜设为 draft 宿主,blur 自动保存(沿用现有 `handleShotBlur`)。

### 2.6 影响 / 非影响
- 改 `StoryboardStage.tsx`(布局重构 + 抽右栏编辑器子组件),不改 server / API / metadata schema。
- 行为等价:所有可编辑字段、保存路径、生成入口保留;只是重新分区。
- 风险:大组件重构,严格沿用现有 handler,不引入新数据流。

---

## 3. 验证策略(CLAUDE.md 强制)

1. `pnpm -r typecheck`(4 包绿)。
2. `pnpm --filter @dramaforge/web build`(构建绿 + 加载根 `.env`)。
3. `pnpm --filter @dramaforge/web test`(web vitest;注意 `test/mocks.ts` 完整性)。
4. `scripts/deploy.sh` → 部署到 your-domain.example.com。
5. `scripts/launch-client-debug.sh` + playwright-cs 截图「资产设定·资产总表视图」+「分镜两栏」,视觉模型核对布局(中栏浏览/右栏编辑职责分离、选中高亮、不拥挤)。
6. 验完关客户端(9222 安全)。

---

## 4. 文件级影响清单

**Feature A**
- 新 `app/workspace/[projectId]/components/AssetMasterPanel.tsx`(从 assets/page.tsx 抽取)
- 改 `app/workspace/[projectId]/assets/page.tsx`(薄壳化)
- 改 `app/workspace/[projectId]/components/AssetDesignStage.tsx`(顶部视图切换 + 嵌入面板)
- 改 `app/workspace/[projectId]/page.tsx`(移除头部资产总表链接)

**Feature B**
- 改 `app/workspace/[projectId]/components/StoryboardStage.tsx`(两栏布局 + 右栏编辑器;可能抽 `SegmentEditorPanel` 子组件)
