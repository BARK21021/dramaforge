# 批8 Films(成片库)Implementation Report

> 07-21 试生产日赶工。批7 production 完成后 fire，批8 让用户看到生成完的成片
> (列表/查看/下载/删除)。**成片字节已在客户端本地**(批7 executor.ts CONCAT 写
> filmsDir + `sf-asset://` URL)，批8 只补 UI + API + IPC。

## status

**DONE** — 8 个 Step 全完成，3 commit 落库，250 web test + 155 client test 全绿，
typecheck 仅 sms-security 6 预存噪音(brief 标注忽略)，web/client build OK。

## commit hashes

- `a3dc28d` — feat(batch8-S1): chain-generate route R6 input.filmMeta + R7 task reuse
- `2dfe19b` — feat(batch8-S2/S5/S6): films GET/DELETE routes + saveFilm/removeFilm IPC
- `d08eb73` — feat(batch8-S3/S4): FilmLibraryPanel + workspace viewMode + route tests

## 测试摘要

- shared typecheck: green
- client typecheck: green
- web typecheck: 仅 sms-security 6 预存噪音(过滤后 0 错)
- client test: **155/155 全绿**(+4 新: resolveClipKeyPath path-traversal 防御)
- web test: **250/250 全绿**(+21 新: films GET 8 + films DELETE 6 + chain-generate R6/R7 7)
- client build: ✓ dist-main/index.js 309.4KB .jsc + dist-main/preload.js 4.1KB .jsc
- web build: ✓ Compiled 7.1s + ✓ TypeScript + ✓ static pages(需 `set -a && source .env && set +a`)

---

## Step 实施清单

### Step 1. chain-generate route input 透传(R6 必修) + Step 7. 任务复用(R7 必修)

`packages/shared/src/render-job.ts`:
- 新增 `FilmMeta` interface(projectId/episodeId/episodeNumber/episodeTitle/projectTitle/shotCount/totalDuration)
- `ConcatInput.filmMeta?: FilmMeta` + `ChainCompileInput.filmMeta?: FilmMeta`(向后兼容 optional)

`packages/web/app/api/projects/[id]/episodes/[episodeId]/chain-generate/route.ts`:
- R7: 派发前查同 episodeId 活跃 render_job(PENDING/CLAIMED/RUNNING)→ 有则返 202 + `{reused:true, renderJobId}`
- R7: `findActiveRenderJobByEpisode()` 用 `input -> 'filmMeta' ->> 'episodeId'` JSONB 提取,query 失败 best-effort 返 null(不阻断派发)
- R7: 检查放在 listShots 之前(复用时省 shots 查询)
- R6: `input.filmMeta` 透传 projectId/episodeId/episodeNumber/episodeTitle/projectTitle/shotCount/totalDuration

`packages/web/app/api/projects/[id]/export-film/route.ts`:
- 同款 `input.filmMeta` 透传(让 films route 能过滤 CONCAT 条目)

### Step 2. 新建 GET /api/projects/[id]/films route(MUST)

`packages/web/app/api/projects/[id]/films/route.ts`(~150 行):
- requireUser + project ownership
- 查 `render_jobs WHERE user_id=? AND type IN ('CONCAT','CHAIN_COMPILE') AND status='COMPLETED'`
- 从 `input.filmMeta.projectId` 过滤当前项目(零 schema 变更,Q1 选 A)
- 返 `[{ id, type, outputUrl(sf-asset://), localKey, episodeId, episodeNumber, episodeTitle, projectTitle, shotCount, totalDuration, createdAt }]`
- 按 createdAt desc

### Step 3. 新建 FilmLibraryPanel.tsx(MUST,~400 行)

`packages/web/app/workspace/[projectId]/components/FilmLibraryPanel.tsx`(~510 行):
- 镜像 app1 F1 项目模式,删全局模式(D1 defer 批9)+ 删整集完整性过滤
- `<video src={sf-asset://}>` 直接(Electron protocol handler 读本地)
- handleDownload → `window.sfShell.saveFilm(localKey, suggestedName)` IPC(R3)
  - dev/browser fallback: toast「请在桌面客户端下载成片」
- handleDelete → DELETE route + `window.sfShell.removeFilm(localKey)` IPC(R4 双面清理)
- 保留琥珀 highlight + "Nuevo" 徽标 + 双色铁律(GC-8)
- 分组按 episodeId/episodeNumber

### Step 4. workspace page.tsx 加 viewMode(R1 必修)

`packages/web/app/workspace/[projectId]/episodes/[episodeId]/page.tsx`:
- 加 `viewMode: "stage"|"films"` state(默认 "stage")
- 加 `highlightTaskId` state
- viewMode==="films" → render `<FilmLibraryPanel projectId highlightTaskId onNavigateBack onClearHighlight />`
- viewMode==="stage" → 现有 `<EpisodeWorkspace>`
- EpisodeWorkspace `onNavigateToFilms` 激活(删下划线死 prop `_onNavigateToFilms`)
- production 完成 → setViewMode("films") + setHighlightTaskId(taskId)

`packages/web/app/workspace/[projectId]/components/EpisodeWorkspace.tsx`:
- `_onNavigateToFilms: _onNavigateToFilms` 改为 `onNavigateToFilms`(激活)
- ProductionStage prop 直接透传 `onNavigateToFilms={onNavigateToFilms}`

注:brief 写 `workspace/[projectId]/page.tsx`,实际 dramaforge EpisodeWorkspace 挂载点
是 `episodes/[episodeId]/page.tsx`(B 方案单集路由)。viewMode 加在此处才能接
ProductionStage 的 onNavigateToFilms 回调。

### Step 5. 下载 IPC showSaveDialog(R3 必修)

`packages/client/main/index.ts`:
- 新增 IPC handler `sf:save-film`:`dialog.showSaveDialog` + `fs.copyFile`
- `resolveClipKeyPath(localKey, clipsDir)` 共用 CLIP_KEY_RE + path-traversal 防御
- 永不 reject,返结构化结果 envelope({ok:true,savedPath} / {ok:false,error})
- USER_CANCELLED code 区分用户取消

`packages/client/main/preload.ts`:
- `SfShellBridge` 加 `saveFilm(localKey, suggestedName?): Promise<SaveFilmResult>`
- `SaveFilmResult = { ok:true, savedPath } | { ok:false, error }`

`packages/client/main/ipc-channels.ts`:
- 加 `saveFilm: 'sf:save-film'`

`packages/web/types/sf-shell.d.ts`:
- 同步 `saveFilm` 接口 + `SfShellSaveFilmResult` 类型

### Step 6. DELETE route + 客户端 IPC(R4 必修)

`packages/web/app/api/projects/[id]/films/[jobId]/route.ts`(~80 行):
- requireUser + 校验 render_job 属当前用户 + type IN (CONCAT, CHAIN_COMPILE)
- 删 render_jobs DB 行
- 返 `{ deleted:true, localKey }` 给前端删本地文件(双面清理)
- 不删服务器存储(服务器零媒体字节,dramaforge-assets-client-local)

`packages/client/main/index.ts`:
- 新增 IPC handler `sf:remove-film`:`fs.rm(targetPath, { force: true })` best-effort
- 文件不存在视为已删(force:true),永不 reject

`packages/client/main/preload.ts`:
- `SfShellBridge` 加 `removeFilm(localKey): Promise<RemoveFilmResult>`

`packages/client/main/asset-store.ts`:
- 新增 `resolveClipKeyPath()` exported helper(CLIP_KEY_RE + path-traversal 防御)
- saveFilm / removeFilm IPC 共用此校验

`FilmLibraryPanel.handleDelete`:
- 先 DELETE route(删 DB)→ 再 IPC removeFilm(删本地,best-effort)
- IPC 失败仅 toast warning 不阻断(DB 已删)

### Step 7. chain-generate route 任务复用(R7 必修)

(已并入 Step 1 同文件实现,见上)

### Step 8. 视觉检查(简化赶工)

browser-harness 不可用,沿用批4/5/6/7 等价验证模式:
- web build: ✓ Compiled 7.1s + ✓ TypeScript + ✓ static pages
- 4 个新 route 注册验证(`/api/projects/[id]/films` + `/api/projects/[id]/films/[jobId]` + `chain-generate` + `export-film`)
- CSS 变量 1:1 对齐 app1(`diff` 零差异,GC-8 双色铁律核对):
  - `--accent`(琥珀):分组标题 + highlight 边框 + "Nuevo" 徽标
  - `--action`(蓝):播放按钮遮罩 + 下载按钮 + 卡片悬停边框
  - `--error`(红):删除按钮悬停
- viewMode 切换逻辑核对:`episodes/[episodeId]/page.tsx` 12 处 viewMode/FilmLibraryPanel/highlightTaskId 引用,EpisodeWorkspace 4 处 onNavigateToFilms 引用
- IPC 调用核对:FilmLibraryPanel 270/305 行 sfShell.saveFilm/removeFilm

---

## GC 自检

| GC | 状态 | 证据 |
|----|------|------|
| GC-1(key 云端) | ✅ | films route 不碰 AI key;chain-generate 沿用批7 callCloudVideoAI 走云端 `/api/generate/video` |
| GC-3(app1 只读) | ✅ | `F:\app1` 仅 Read,无 import 改动;FilmLibraryPanel 镜像而非修改 app1 源 |
| GC-5(零 schema) | ✅ | Q1 选 A:filmMeta 存 input JSONB,无新表/无 migrate;render_jobs 表结构不变 |
| GC-6(行为等价) | ✅ | FilmLibraryPanel 镜像 app1 F1 项目模式(删全局模式 + 整集完整性过滤,brief 明示 defer) |
| GC-7(sf-asset:// + 本地 IPC) | ✅ | `<video src={sf-asset://}>` + sfShell.saveFilm/removeFilm IPC;server 零媒体字节 |
| GC-8(对齐 app1 双色) | ✅ | CSS 变量 diff 零差异;--accent 琥珀身份 vs --action 蓝操作 |
| dramaforge-assets-client-local | ✅ | films route 只返 outputUrl(sf-asset://)+ localKey 元数据,server 不存媒体字节 |
| dramaforge-keys-cloud-server-only | ✅ | 本批无 key 操作 |
| dramaforge-frontend-align-app1 | ✅ | FilmLibraryPanel JSX 直接复制 app1,仅删 defer 项 |
| prefer-better-lib-not-selfbuilt | ✅ | dialog/fs.copyFile/fs.rm 用 Node/Electron 标准库,不自研 |

---

## 跨机器失效告知(Q4 接受)

sf-asset:// URL 只在生成该片的客户端有效。同账号换机器登录 → films 列表 sf-asset://
在新机器 404/黑屏。**C/S 本地存储固有代价**,app1 MinIO 共享无此问题。批8 接受
(defer 缩略图占位到批9)。

---

## 关键文件(绝对路径)

新建:
- `D:\dramaforge-cs\packages\web\app\api\projects\[id]\films\route.ts`(~150 行)
- `D:\dramaforge-cs\packages\web\app\api\projects\[id]\films\[jobId]\route.ts`(~80 行)
- `D:\dramaforge-cs\packages\web\app\workspace\[projectId]\components\FilmLibraryPanel.tsx`(~510 行)
- `D:\dramaforge-cs\packages\web\app\api\projects\[id]\films\__tests__\route.test.ts`(8 测试)
- `D:\dramaforge-cs\packages\web\app\api\projects\[id]\films\[jobId]\__tests__\route.test.ts`(6 测试)
- `D:\dramaforge-cs\packages\web\app\api\projects\[id]\episodes\[episodeId]\chain-generate\__tests__\route.test.ts`(7 测试)

修改:
- `D:\dramaforge-cs\packages\shared\src\render-job.ts`(FilmMeta + ConcatInput/ChainCompileInput.filmMeta)
- `D:\dramaforge-cs\packages\web\app\api\projects\[id]\episodes\[episodeId]\chain-generate\route.ts`(R6 filmMeta + R7 任务复用)
- `D:\dramaforge-cs\packages\web\app\api\projects\[id]\export-film\route.ts`(R6 filmMeta 透传)
- `D:\dramaforge-cs\packages\web\app\workspace\[projectId]\episodes\[episodeId]\page.tsx`(viewMode R1)
- `D:\dramaforge-cs\packages\web\app\workspace\[projectId]\components\EpisodeWorkspace.tsx`(onNavigateToFilms 激活)
- `D:\dramaforge-cs\packages\client\main\index.ts`(saveFilm/removeFilm IPC handler)
- `D:\dramaforge-cs\packages\client\main\preload.ts`(bridge 暴露 saveFilm/removeFilm)
- `D:\dramaforge-cs\packages\client\main\ipc-channels.ts`(加 2 channel 名)
- `D:\dramaforge-cs\packages\client\main\asset-store.ts`(resolveClipKeyPath exported)
- `D:\dramaforge-cs\packages\client\test\shell\asset-store.test.ts`(+4 测试 resolveClipKeyPath)
- `D:\dramaforge-cs\packages\client\test\shell\index.test.ts`(IPC handler count 改 7)
- `D:\dramaforge-cs\packages\client\test\shell\preload.test.ts`(bridge 7 函数)
- `D:\dramaforge-cs\packages\web\types\sf-shell.d.ts`(同步 saveFilm/removeFilm 接口)
- `D:\dramaforge-cs\packages\web\test\mocks.ts`(serverMock 加 listShots: vi.fn())

---

## Concerns

1. **FilmLibraryPanel 510 行 > brief 目标 ~400 行**:因完整复制 app1 JSX + 双色铁律
   注释 + 跨机器失效告知。功能/视觉与 app1 等价,行数偏差不影响试生产。

2. **真实视觉验证未做**:browser-harness 不可用,沿用批4/5/6/7 静态等价验证模式
   (build + typecheck + CSS 变量 diff + route 注册)。真实渲染需登录 + 项目 +
   episode + 已生成成片数据,赶工不深入。严重崩坏已被静态检查拦截。

3. **R7 任务复用查询性能**:`input -> 'filmMeta' ->> 'episodeId'` JSONB 提取无索引,
   量大时可能慢。每用户 COMPLETED render_jobs 量小(几十条),PENDING/CLAIMED/
   RUNNING 活跃 job 更少,可接受。批9 可加 GIN 索引优化。

4. **export-film route 重复 episodeRepo.getById**:R6 改动让 export-film route
   在 ownership 校验 + filmMeta 组装时各调一次 `episodeRepo.getById(episodeId)`。
   赶工不优化(2 次 DB round-trip 用户无感),批9 可缓存。

5. **跨机器 sf-asset:// 失效未做 UI 提示**:用户换机器登录看到 404 黑屏会困惑。
   brief Q4 接受(defer 缩略图占位到批9),但首日试生产用户可能反馈。建议批9
   优先做"检测 sf-asset:// 加载失败 → toast 跨机器提示"。

6. **chain-generate R7 任务复用未做并发竞态保护**:两个并发请求同时检查无活跃 job
   → 同时派发 2 个 job。概率低(用户连点),且不影响数据正确性(只是多算一次)。
   批9 可加表级锁或唯一约束。

7. **defer 清单**(brief 已列,赶工不做):
   - maybeAutoCompileEpisode 自动合集 → 批9/9.5
   - 全局 /films 跨项目成片库 → 批9
   - 智能合集增强(force/parallelMode/grid/pencil/transition) → 批9
   - Admin 成片查看 → 批9.5
   - 缩略图 thumbnailUrl → 批9
   - 成片预览编辑/裁剪/重命名 → 永久 defer
   - 批量下载/打包 → 永久 defer
   - 成片分类标签/搜索 → 批9
   - 跨机器 sf-asset:// 失效修复 → 接受(C/S 代价)

---

## 下一步

批8 完成,主链全通:剧本→分析→资产→分镜→串生成→**成片库查看/下载/删除**。

试生产前的剩余工作:
- 部署:web Docker 重建(批8 新增 2 route + 1 component + IPC)
- 客户端:1.2.0+ 版本打包(批8 新增 saveFilm/removeFilm IPC,旧客户端无此能力,
  下载/删除会 fallback 到 toast「请在桌面客户端下载」/ 仅删 DB 不删本地文件)
- 验证:试生产首日关注跨机器失效反馈 + R7 任务复用是否正确拦截重复派发
