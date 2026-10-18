# dramaforge HANDOFF 状态（2026-07-21）

## 🔥 平台 API Key 池上线（2026-07-21 · tag `keypool` · 加权轮询+健康熔断+粘性 key 防 403+admin UI）

用户需求：多 key 池**加权**轮询 + admin 自由增删 key + 规避多 key 轮转 403。搬 app1 池子但补 app1 没有的粘性 key 锁（比 app1 稳）。

- **部署**：`bash deploy.sh keypool` 全 8 步 exit 0；migrate 跑 `0005-platform-api-keys.sql`（userId 可空+provider_files 粘性锁表）+ `0006-contract-indexes.sql`（subagent 偷建的索引修正，幂等）；`/api/health`→200；psql 确认 provider_files 建成 + userId 可空。
- **代码**：LoadBalancer(weighted) + ApiKeyPool(pick/recordSuccess/recordFailure/classifyKeyError/reap) + getCredential(pin>池>env) + callAI 健康回写+粘性 fileId 锁 + kimi 上传写归属/复用锁原 key + ai-worker cooldown reap + admin 4 路由 + ApiKeyPoolCard(admin-only，替换 settings 关于块)。
- **gate**：server tc0+591测(+12新) / web tc0+378测 / web build exit0。
- **今天零行为变化**：无平台 key 行→回退 env（=今天）。admin 在 UI 粘 key（来自 项目key.txt）才激活轮询。
- **403 修复**：文件归账号 A 永用 A 的 key（provider_files 粘性锁），不漂 B。
- 回滚：`bash rollback.sh`。



## 🔥 navfix 部署（2026-07-21 晚 · tag `1.1.4-navfix` · 修 P0 导航失效）

**用户报 1.1.4 装后 sidebar tab 全点不动**。根因：`AppShell.tsx` 顶层 `<GlobalGenerationStatus>` 的 useSSE()→useSyncExternalStore 订阅模块级全局单例，打断 Next16/React19 client 路由 commit（Link 发合法 RSC flight 但 URL 不切；auth 分支无此组件故正常）。修复：移除 GlobalGenerationStatus。

- **web-only 部署**（客户端加载云端 web，无需重打 exe）：`bash deploy.sh 1.1.4-navfix` 全 8 步过 + [8/8] prune 回收 1.419GB
- 验证：`/api/health`→200 `{"ok":true}` / `/` Electron UA→200 / dramaforge-web Recreated+Started / postgres·redis·minio Healthy
- **用户实测**：Ctrl+R 刷新 → 点 sidebar tab（工作区/成片库/镜头组/设置）→ URL 应切换
- **defer**：GlobalGenerationStatus 顶栏条用正确方式（不在 layout 顶层订阅 / 重构 SSE hook）恢复
- 回滚：`bash rollback.sh`



## 🔥 今晚大对齐（2026-07-21 晚 · 1.1.4 round · 代码完成 + 验证通过 · ✅ cutover 已执行上线 1.1.4）

> **✅ 2026-07-21 19:25 cutover 完成（用户授权「全量 cutover(server+exe)」后执行，我独立复核非信 agent）**
> - **server**：`bash deploy.sh 1.1.4-server` exit 0，7 步全过 + [8/8] prune 回收 1.417GB；`/api/health`→**200**
> - **client**：exe 1.1.4 156M build（bytenode protect ok:1 + electron-builder nsis signtool）+ scp 上传 `/opt/dramaforge/client-releases/`
> - **manifest**：`latestVersion=1.1.4` `minVersion=0.0.0` `win=.../DramaForge-1.1.4-x64.exe`（软推，UPDATE 1）
> - **双 curl 终验**：`/downloads/...1.1.4.exe`→**200**（163MB）；`/api/client/update?version=1.1.3&os=win`→`{latestVersion:1.1.4,force:false}` ✅
> - 所有 1.1.0/1.1.1/1.1.2/1.1.3 客户端下次 1h updater 轮询自动升 1.1.4
> - **回滚**：server `bash rollback.sh`；client manifest latestVersion 改回 1.1.3
> - **待用户实测**：像素级视觉对比 app1（本地 vision 受限，渲染冒烟过但像素级待真客户端）+ 各阶段 UI + ORIGINAL 整剧重写 + 检查更新 + 成片库

用户指令："能对齐的都要对齐，今晚全部对齐，多用子agent" + "最后你验收"。用 ~15 个子agent 并行完成 8 批 + 收尾，全部绿。

### 完成清单（本 round 新增，对照 F:\app1）
- **批0 基础设施**：UI 库 7 组件 / useTaskStatus 扩展 + index barrel / models.ts 加 rateLimit / server SSE event-publisher
- **批1**：全局 shell + 列表 + 设置页(262→709行，删 GC-1 BYOK，加 修改密码/退出/稀疏网格/铅笔 卡)
- **批2-6**：EpisodeWorkspace 编排核心 / input / analyzing / assets(最大) / storyboard
- **批7**：ProductionStage(1227→**4050行**) + VideoEditor(新,498行) + GenerationProgress(新,670行) + ffmpeg 100% 挪 client(chain-generate→CHAIN_COMPILE / export-film→CONCAT，字节不过服务器)
- **批8**：成片库 GroupLibraryPanel(新,507行) + /api/groups(新) + 全局路由 + EpisodeTabs(B-方案多路由)
- **转绘 X3**：OriginalRewriteStage(整剧重写,新) + client `sf:stage-original-video` IPC(第13通道，193测试)
- **装配**：OriginalRewriteStage→EpisodeWorkspace input 阶段 / GlobalGenerationStatus→AppShell 顶栏 / ActiveTaskStatusBar→EpisodeWorkspace
- **设置**：ClientConnectionCard 检查更新按钮(`sf:check-for-update` IPC，manual→推最新版)
- **运维**：deploy.sh 加 **[8/8] 旧 image tag prune**(防本次 P0 磁盘满复发，只留 latest+rollback+当前TAG)

### 验收（我独立复核，非仅信 agent）
| 项 | 结果 |
|----|------|
| web typecheck | ✅ 仅 sms-security 7 pre-existing 噪音 |
| web production build | ✅ exit 0，全路由编译 |
| server typecheck | ✅ 0 错 |
| client typecheck | ✅ 0 错 |
| client vitest | ✅ 193/193 |
| X3.7 链路 trace | ✅ component→route→orchestrator→ffmpeg sound；videoUrl 用绝对本地路径(非 sf-asset://，ffmpeg 直读)设计正确 |
| 运行时渲染 | ✅ landing 200(Electron UA,1440×900,1.5MB) / settings·workspace·groups 200(页 shell) / api/health 200 / api/groups 401 / original-video-upload 405 |
| **像素级视觉** | ⚠️ **本会话不可用**（见下） |

### ⚠️ 像素级视觉验证为何没做完（诚实记录）
CLAUDE.md 强制 vision.py 截图 + 视觉模型。本会话阻塞于环境，非代码：
1. Turbopack **dev** 模式在本机 panic(Windows `0xc0000142`，globals.css PostCSS worker spawn) → 改用 `next start` 生产服务器绕过(landing 正常 200)
2. vision.py 无 API key —— 本地 `/d/dramaforge-cs/.env` 是 **template**(ARK/OPENAI/DASHSCOPE key **全空**，真 key 仅在生产服务器)
3. mcp analyze_image 无法解析 Read 返回的 CDN URL(内嵌 Windows 反斜杠路径，签名锁死)
→ 渲染冒烟通过(landing + 各页 shell 全 200，新路由 401/405 非 404/500)，但**像素级布局(对齐/间距/溢出)未做**，需用户在 1.1.4 真客户端实测对比 app1。

### 🚧 cutover（outward-facing，待用户授权，不擅自执行）
代码 100% ready。授权后：
1. **server**：`cd /d/dramaforge-cs && bash deploy.sh`（含新 [8/8] prune；DB 无 migration —— gridOverlayEnabled/pencilPaint/costumes 列 0001-init.sql 已存在）
2. **client**：bump `packages/client/package.json` 1.1.3→**1.1.4** → electron-builder repackage(含 检查更新按钮 + stageOriginalVideo IPC + 8 批 UI) → 上传 `root@YOUR_SERVER:/opt/dramaforge/client-releases/` → 更新 `system_configs.CLIENT_VERSIONS_MANIFEST` latestVersion=1.1.4, minVersion=0.0.0
3. **用户实测清单**：设置页检查更新 / ORIGINAL 项目整剧重写(选视频→本地暂存→派发) / 各阶段 UI 对齐 app1 / 成片库

### 2 个待用户决策（defer）
1. **RedisStatus**(~291行，运维向)：app1 设置页有，dramaforge 暂跳过。要补吗？
2. **TTS/Lipsync 补全**：siliconflow/fal/vidu 本地 .env 有 key 但 provider 约束排除。要纳入吗？

---

## ✅ [历史] cutover 已完成（2026-07-21 · 6 批上线 1.1.3）

**生产已切到 6 批新镜像 + client 1.1.3**：
- server deploy.sh 7 步全过（web/ai-worker latest，/api/health 200）
- client publish 1.1.3：DramaForge-1.1.3-x64.exe 155MB（含音色库 44MB + 6 批），endpoint latestVersion=1.1.3，下载 200 OK
- 6 批：①转绘流式(FormData OOM 修复) ②图片上传(落 sf-asset://) ③资产重命名(6 表级联) ④costume 变体(i2i) ⑤稀疏网格 ⑥音色库(200wav 试听绑定)
- route 验证：rename / chain-generate / generate-text 均 401（进 bundle 非 404）

**⚠ 中途 P0 事故已修复**：磁盘 100% 满 → postgres 无限 recovery loop（全功能挂~10min，endpoint 返 0.0.0 fallback）。根因 15+ 历史 docker image tag 堆积 ~12GB。清 16 个旧 tag（保留 web/ai-worker latest+rollback + app1 备回滚）→ 100%→58%（16G 可用）→ postgres 自愈 healthy。**建议 deploy.sh 加旧 tag prune 防复发**。

**version 冲突处理**：续32 已占 1.1.2（updater 严格比较，同版本不推）→ bump package.json 1.1.2→1.1.3 + 重打 exe。所有客户端（1.1.0/1.1.1/1.1.2）< 1.1.3 → updater 自动推到 6 批版。软提示 minVersion=0.0.0（不 --force）。bytenode preload 修复确认在 1.1.3（protect.mjs targets 只 index.js）。

**留用户试生产验证**（功能级 E2E，需登录客户端实测）：转绘大视频不 OOM / 图片上传落地 sf-asset:// / 重命名 6 表级联 / costume i2i 生图 / 网格开关生效 / 音色库试听+绑定+AI 建议音色。

---


## Hermes agent：联系失败 ❌
- `agent-tool-host.exe` **未运行**（tasklist 无匹配进程）
- 无 hermes CLI、无监听端口、`C:/Users/<user>\.hermes` 目录不存在
- 与 8 天前 memory 一致：无程序化接口，无法发消息
- 若需 Hermes 参与：用户回来手动启动它 + 提供接口/端口/共享目录

## 赶工 6 批进展（攒批待 cutover，server+client 须同步部署）

| 批 | 功能 | 状态 | 关键点 |
|----|------|------|--------|
| 1 | 转绘流式 | ✅ done | generate-text JSON→FormData（OOM 修复），**契约变了→必须同步部署** |
| 2 | 图片上传 | ✅ done | saveLocalAsset IPC + AssetCard 上传/换图 UI |
| 3 | 资产重命名 | ✅ done | rename-service 单事务 6 表级联（assets/projects/episodes/shots/storyboards/tasks，replaceNameDeep + RENAME_SKIP_KEYS，仅 CHARACTER）+ route + 34 测试 |
| 4 | costume 变体 | ✅ done | AssetDesignStage 造型变体区（变体生图/上传，i2i 走 readAssetToBaseUrl→referenceImageBase64）+ 网格/铅笔开关 UI + server AssetRecord 加 grid/pencil 读回 |
| 5 | 稀疏网格（client）| ✅ done | grid-overlay 默认稀疏九宫格（cells 100→3）+ chain-generate applyCharacterAssetGridOverlay（读 characterReferenceImageUrls/gridEnabled） |
| 5 | 稀疏网格（调度路由）| ✅ done | chain-generate route 按 `shot.referencedAssets.characters` 名字匹配 `gridOverlayEnabled=true` 的 CHARACTER 资产 → 注入 `characterReferenceImageUrls`+`gridEnabled`。**端到端通**（开关→分镜→串生成→route→client 叠稀疏九宫格→云端 AI）。8 新测试 15/15 过。⚠ 比 app1 保守：只 gridOverlayEnabled=true 的 CHARACTER 入参考；gridEnabled 不能 body 关闭（按资产配置自动派生） |
| 6 | 音色库 client | ✅ done | 200wav/44MB+manifest 进 exe（extraResources）+ voice-store.ts（三层路径防御）+ IPC listPresetVoices/readPresetVoice（契约已就绪给 web 用）+ 16 测试，client tsc 0 错/vitest 190 过 |
| 6 | 音色库 web/server | 🔄 agent 跑 | AssetDesignStage 音色区 + VoiceBrowserModal（照搬 app1）+ server manifest + validateSuggestedVoices |
| 6 | 铅笔彩绘 | ⏸ defer | 用户「暂时不用铅笔彩绘，只用稀疏网格」 |

## cutover（等用户确认，不擅自生产部署）
**前置验证全过** ✅：typecheck 3 包（server 0/client 0/web 仅 pre-existing sms-security）/ vitest 3 包零新 fail（server 521 / client 190 / web 311）/ web production build exit 0 / client main bundle + protect exit 0 / **client exe 产出 `DramaForge-1.1.2-x64.exe` 156MB（含音色库 44MB + ffmpeg + sharp，electron-builder exit 0）**。详细步骤见 **`CUTOVER-RUNBOOK.md`**。

**不擅自执行**：生产部署（YOUR_SERVER `bash deploy.sh`）+ exe repackage + 推用户更新都是 outward-facing，用户不在场，只准备好等确认。

agent 全回来后完善的步骤框架：
1. **server**：本地 `set -a && source .env && set +a && pnpm build`（web）→ docker rebuild image → 部署 root@YOUR_SERVER（SSH key `C:/Users/<user>\.ssh\deploy_key`）
2. **DB**：无 migration（gridOverlayEnabled/pencilPaintEnabled/costumes 列 0001-init.sql 已存在；rename 不加列只 UPDATE）
3. **client**：repackage exe（electron-builder，含音色库 44MB wav + 网格 + costume UI + 新 IPC）
4. **用户**：下载新 exe（音色库让 exe 变大 ~44MB+）
5. **验证清单**：转绘流式 / 图片上传 / costume 变体生图 / 网格开关生效 / 重命名级联 / 音色库试听绑定

⚠ 批1 契约变更：server+client 必须同步，先发哪个都让另一端坏。

## 已知 pre-existing 测试噪音（非本次引入）
- web `test/sms-security.test.ts` ~6 类型错（RequestInit/signal/NODE_ENV）
- server `test/domain/asset.test.ts:183` ASSET_KINDS 白名单含 ENTITY（旧测试断言过时）

## 待用户回来确认
- [ ] cutover 生产部署执行（或授权我执行）
- [ ] Hermes 是否需要启动参与
- [ ] 音色库 200wav license 已确认（用户说有）
