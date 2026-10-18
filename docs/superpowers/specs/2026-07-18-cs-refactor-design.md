# DramaForge Studio C/S 重构设计

- 日期: 2026-07-18
- 状态: 已批准（2026-07-18 用户复核通过）
- 源项目: `D:\app1`（B/S 架构，**保持不动**，仅作参考与代码移植来源）
- 目标项目: `D:\dramaforge-cs`（新 C/S 架构，独立 git）
- 服务器: YOUR_SERVER（阿里云 ECS，1 核 1.8GB，Alibaba Cloud Linux 3）
- 域名: your-domain.example.com（HTTPS）

---

## 0. 背景与动机

app1 现为 B/S：浏览器 → 云端 nginx → web(Next.js) + worker。worker 既跑 AI 调用**又跑 ffmpeg**（合片/导出成片/抽帧/长视频切片）。服务器 1.8GB 内存跑 ffmpeg 会 OOM 整机崩溃，导致线上 `FILM_EXPORT` / `CHAIN_GENERATE` / `LONG_VIDEO_REWRITE` / `video-split` 全部失效。

ffmpeg 代码在 app1 中高度集中（`core/video/ffmpeg-pipeline.ts`、`long-video-service.ts`、`grid-overlay.ts`、`workers/video.worker.ts`、`workers/text.worker.ts`、`app/api/projects/[projectId]/video-split/route.ts`），且代码里**早有客户端/服务器边界意图**（`long-video-client-boundary.test.ts` 禁止客户端 import 服务器专属模块）。这给"ffmpeg 挪客户端"提供了抓手。

### 用户硬约束（逐字，贯穿全程）
- "api key 肯定不可能分发给用户的，肯定得放服务器" → AI key 只在服务器
- "ffmpeg 合片不能本地完成吗，不要在服务器上完成" → ffmpeg 不在服务器
- "一定要稳定要快，如果服务器崩溃了，那就完蛋了" → 服务器稳定是命门
- "cs架构务必要有心跳与版本上报（断代版本强制淘汰），静默下载器模块，日志本地存储与懒上报" → 3 个运维骨架
- "毕竟你上下文有限制，你便做边把重点记录到文本中别思绪错乱了" → 持续写 WORKLOG
- "这个必须要稳定" → 稳定优先
- 内部公司用，浏览器访问

---

## 1. 关键决策（已与用户确认）

1. **客户端形态**：桌面 App（Electron）为主力，浏览器备用。
2. **交付范围**：分层模块化 C/S，ffmpeg 挪客户端，主流程（剧本→资产→分镜→生成→合片）跑通；边角细节后续迭代。
3. **界面来源**：方案 A（薄壳 + 云端界面）—— 桌面 App 加载云端网页（界面只维护一份）+ 本机 ffmpeg。否决方案 B（厚壳本地界面：两份界面、与"上云"方向相反）。

---

## 2. 架构（方案 A）

```
桌面 App (Electron)                       云端服务器 (YOUR_SERVER)
├─ BrowserWindow: 加载 your-domain.example.com ◀──HTTPS──▶ nginx :443
│   (云端界面，与浏览器同款)                       │
├─ render-worker (本机 ffmpeg)                    ├─ web (Next.js): 界面+API+AI网关+登录+任务调度
│   HTTP 拉 render-job ◀──HTTPS──▶ /api/render/*  ├─ ai-worker (BullMQ): 只跑纯 AI 任务，无 ffmpeg
│   本机跑 ffmpeg → 上传 MinIO ──HTTPS──▶ MinIO    ├─ postgres / redis / minio
├─ ops-heartbeat: 每 30s POST /api/client/heartbeat
├─ ops-updater: 轮询 /api/client/update 静默下载
└─ ops-logger: 本地滚动日志 + 懒上报 /api/client/logs
```

- **服务器完全不装 ffmpeg**（去掉 OOM 崩溃根因）。
- **业务数据全在云服务器**（postgres/redis/minio）。客户端本机只存：① ffmpeg 临时文件（合片下载的片段+产物，用完即删）② 本地日志 ③ 静默下载的更新包缓存。客户端不持有任何业务数据，换机装 App 登录即用。
- **浏览器备用**：除"合片/导出/长视频/视频拆分"外都能用；这些 ffmpeg 任务需桌面 App 渲染。

---

## 3. 模块划分（monorepo，15 模块：①-⑪、⑬-⑮ 各派一子 agent 重构，⑫ 由主 agent 串联）

```
dramaforge-cs/
├─ packages/
│  ├─ shared/              ① 共享层：类型 + render-job 契约 + 纯工具(long-video-plan 等 client-safe)
│  ├─ server/              云端服务器
│  │  ├─ db+config/        ⑦ pg 封装 + 手写迁移 + env(Zod) + NextAuth + redis
│  │  ├─ gateway/          ② AI 网关(13 家 provider，key 在此，从 app1 移植)
│  │  ├─ domain/           ③ 领域核心(计费/并发/存储/工作流/提示词/分镜/资产)
│  │  ├─ task/             ④ 任务调度 + render-job 派发(新)
│  │  ├─ web/              ⑤ Next.js 界面 + 78 API(精简去 ffmpeg + 加 render/client 接口)
│  │  └─ ai-worker/        ⑥ BullMQ worker(只跑纯 AI 任务)
│  └─ client/              桌面 App
│     ├─ ops-heartbeat/    ⑬ 心跳 + 版本上报 + 断代强制淘汰
│     ├─ ops-updater/      ⑭ 静默下载器
│     ├─ ops-logger/       ⑮ 本地日志 + 懒上报
│     ├─ ffmpeg/           ⑧ ffmpeg 管线(从服务器挪来：concat/extractFrame/split/duration/downloadClips/grid-overlay)
│     ├─ render-worker/    ⑨ 本地渲染 worker(HTTP 拉 render-job → 跑 ffmpeg → 上传)
│     ├─ orchestrators/    ⑩ 链式生成/长视频转剧本编排(从 video.worker/text.worker 挪来，调云端 AI API)
│     └─ shell/            ⑪ Electron 壳(BrowserWindow 加载云端界面) + preload IPC
└─ ⑫ 集成串联：docker-compose / 构建脚本 / 部署脚本 / 端到端联调（主 agent 做）
```

**执行顺序**：① 先做（其他都依赖它的契约）→ ⑬⑭⑮ 运维骨架 + ②-⑪ 并行重构 → ⑫ 最后串联。

---

## 4. render-job 契约（服务器 ↔ 客户端 ffmpeg 任务，核心新件）

### 4.1 存储
新增 `render_jobs` 表（倾向 PG，便于审计与持久；plan 阶段定）：
```
id, task_id(FK), user_id, type, input(JSONB), status(PENDING|CLAIMED|RUNNING|COMPLETED|FAILED),
claimed_by(client machineId), created_at, claimed_at, completed_at, error, result(JSONB)
```
- `type` ∈ `CONCAT` | `EXTRACT_FRAME` | `SPLIT_BY_DURATION` | `SPLIT_EVENLY` | `CHAIN_COMPILE` | `LONG_VIDEO_REWRITE`
- `input` 含：片段 URL 列表、参数、输出上传目标（MinIO presigned URL 或服务器中转）

### 4.2 客户端拉取/回传 API（均 cookie/session 鉴权）
| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/client/heartbeat` | `{version,os,machineId}` → `{status:"ok"\|"force_upgrade", minVersion, downloadUrl}` |
| GET | `/api/render/jobs/next?machineId=x` | 原子认领并返回下一个 PENDING render-job（无则 204） |
| POST | `/api/render/jobs/:id/progress` | `{progress, stage}` |
| POST | `/api/render/jobs/:id/result` | `{outputUrl, duration, ...}` 或 multipart 上传成片→服务器存 MinIO |
| POST | `/api/render/jobs/:id/failed` | `{error, logSnippet}` |
| POST | `/api/client/logs` | `{machineId, logs, taskId?}` 懒上报 |
| GET | `/api/client/update?version=x&os=win` | `{latestVersion, downloadUrl, force?}` 静默下载器查询 |

### 4.3 认领原子性
`GET /api/render/jobs/next` 用 PG 行锁 `FOR UPDATE SKIP LOCKED` 原子认领，避免多客户端重复领。

---

## 5. 任务归属

| 任务类型 | 跑在哪 | 说明 |
|---|---|---|
| `VIDEO_GENERATE`(单镜) | 服务器 ai-worker | 纯 AI（ARK/Seedance） |
| `IMAGE_*` / `VOICE_*` | 服务器 ai-worker | 纯 AI |
| `TEXT_*`（除长视频） | 服务器 ai-worker | 纯 AI（DeepSeek/Kimi） |
| `FILM_EXPORT` | 客户端 render-worker | 纯 ffmpeg concat |
| `CHAIN_GENERATE` | 客户端 orchestrators + render-worker | 客户端编排：逐组调云端 AI API → 本地 ffmpeg 衔接/合片 |
| `LONG_VIDEO_REWRITE` | 客户端 orchestrators + render-worker | 客户端编排：本地 splitVideoEvenly → 调云端 Kimi/DeepSeek |
| `video-split` | 客户端 render-worker | 纯 ffmpeg split |

服务器 worker **不再 import 任何 ffmpeg 模块**。

---

## 6. 运维基础骨架（用户强制要求）

### 6.1 心跳 + 版本上报 + 断代强制淘汰
- 客户端启动后每 30s `POST /api/client/heartbeat {version, os, machineId}`。
- 服务器读 `system_configs.MIN_CLIENT_VERSION`，比对客户端版本。
- 客户端版本 < `MIN_CLIENT_VERSION`（断代，如 render-job 契约不兼容变更）→ 返回 `status:"force_upgrade"` + `downloadUrl`。
- 客户端收到 force_upgrade：锁死界面（只留升级提示）→ 触发静默下载器优先下载 → 提示重启。
- 运维改 `MIN_CLIENT_VERSION` 一键淘汰旧版（无需改客户端）。

### 6.2 静默下载器
- 后台轮询 `/api/client/update?version=x&os=win`，有新版静默下载到本地缓存。
- 下完提示"重启生效"；空闲时自动重启。
- force_upgrade 时优先下载 + 强提示。
- 分发通道：MinIO 静态托管安装包 + 版本清单（plan 阶段定）。

### 6.3 本地日志 + 懒上报
- 客户端所有操作（含每次 ffmpeg 命令/入参/结果/耗时）写本地滚动日志（按天切，上限保留 N 天）。
- 懒上报三种触发：① 出错自动上传相关日志 ② 运维 `/api/client/logs/request` 点名拉某机日志 ③ 每天定时批量上传。
- 服务器存 MinIO 或 `/var/log/sf-clients/{machineId}/`，供运维排障。

---

## 7. 主流程数据流

### 7.1 导出成片（FILM_EXPORT，纯 ffmpeg）
用户点导出 → web 建 `FILM_EXPORT` 任务 + 写一条 `render_jobs(type=CONCAT, input=片段URL列表)` → render-job 入队 → 桌面 App render-worker `GET /api/render/jobs/next` 拉到 → 本地 `downloadClips` + `execFfmpegConcat` → 上传成片到 MinIO → `POST /api/render/jobs/:id/result` → web 标记任务完成 → SSE 推前端。**全程服务器没碰 ffmpeg**。

### 7.2 链式生成（CHAIN_GENERATE，AI+ffmpeg 交织）
web 建 `CHAIN_GENERATE` 任务 + 写 `render_jobs(type=CHAIN_COMPILE, input=分组定义+参数)` → 客户端 orchestrator 拉到 → 逐组：调云端 `POST /api/generate/video`（AI 在服务器，key 不出服务器）生成本组视频 → 本地 `extractLastFrame`+`grid-overlay` 生成下组参考帧 → 全部完成后本地 `execFfmpegConcat` 合片 → 上传 → 回传结果。AI 调用走云端 API，ffmpeg 全在本机。

---

## 8. 错误处理与降级
- **无桌面客户端在线**：render-job 停留 PENDING，前端显示"等待渲染客户端"；配超时（如 30min）可标记失败。
- **ffmpeg 失败**：render-job 标 FAILED + 自动上报日志片段；任务可重试（BullMQ attempts）。
- **浏览器用户点导出**：提示"需桌面 App 渲染"，任务排队等客户端。
- **客户端版本过旧**：心跳强制淘汰，锁死 + 静默升级。
- **客户端崩溃中断**：render-job 的 CLAIMED 状态配超时回收（类似 app1 的 reaper），超时回 PENDING 重新分配。
- **服务器 OOM 风险已消除**：服务器不跑 ffmpeg，不 build（沿用 app1 本地 build→save→load 方案）。

---

## 9. 测试策略
- **边界测试**：扩展现有 `long-video-client-boundary.test.ts` —— 客户端包禁止 import 服务器专属模块（db/gateway/redis/ai-worker）。
- **契约测试**：shared 的 render-job 请求/响应 schema，服务器与客户端双向校验。
- **ffmpeg 管线**：小样例视频跑 concat/extractFrame/split 集成测试（客户端侧）。
- **心跳/版本门**：单测 `MIN_CLIENT_VERSION` 语义比较 + force_upgrade 响应。
- **认领原子性**：并发 `GET /next` 不重复认领。
- 沿用 app1 的 vitest（unit 无 DB / integration 需 PG+Redis）分项目结构。

---

## 10. 部署
- **服务器**：`docker-compose.yml` 精简为 web / ai-worker / postgres / redis / minio（**无 ffmpeg**）。沿用 app1 的 `deploy.sh` 思路（本地 build → docker save|gzip|ssh load → migrate → up -d --no-build）。
- **客户端**：`electron-builder` 打包 Windows x64（含 ffmpeg 二进制 + 静默下载器 + bytenode 保护沿用 app1 `protect.mjs`）。分发安装包给内部用户。
- **新文件夹** `D:\dramaforge-cs` 独立 git。

---

## 11. 稳定性要点（命门，最高优先）
1. 服务器**绝不跑 ffmpeg**、**绝不在服务器 build**（1.8GB OOM 根因全部消除）。
2. render-job 认领原子 + 超时回收，避免任务卡死。
3. 心跳 + 断代淘汰，避免旧版客户端拉到不兼容契约导致静默失败。
4. 日志懒上报，出问题能拿到客户端现场。
5. 容器 `restart: unless-stopped` + 开机自启（沿用 app1）。
6. 每步改动后跑 typecheck + 相关单测，主流程端到端验证后才算完成。

---

## 12. 不在范围 / 后续迭代
- 边角功能（口型同步细节、视频批量处理高级参数等）主流程跑通后迭代。
- 客户端 macOS/Linux 支持（先 Windows x64）。
- L5 机器绑定许可证（app1 加密方案的高级层，暂缓）。
- 浏览器端 ffmpeg（不可能，浏览器跑不了 ffmpeg，明确放弃）。

---

## 13. 待 plan 阶段细化的开放问题
1. `render_jobs` 存 PG 还是 Redis（倾向 PG 审计）。
2. CHAIN_GENERATE 客户端编排的逐组错误恢复细节。
3. 客户端 ffmpeg 二进制来源（`@ffmpeg-installer/ffmpeg` vs 沿用 `videostylization/whisper/ffmpeg.exe`）。
4. 客户端更新分发通道（MinIO 静态托管 + 版本清单 JSON）。
5. 客户端登录态从 shell 传给 render-worker 的方式（同源 cookie 共享 vs token）。
6. preload IPC 是否暴露本地 ffmpeg 给网页（预览等，phase 1 可不做）。
7. 15 模块子 agent 的并行批次划分与依赖排序（writing-plans 阶段定）。

---

## 14. 实现方式
spec 批准后 → `writing-plans` skill 生成实现计划 → 按 15 模块派子 agent 重构（① 先行，②-⑪ + ⑬⑭⑮ 并行，⑫ 串联）→ 主 agent 端到端联调。全程边做边写 `../../archive/WORKLOG.md` 防上下文丢失。
