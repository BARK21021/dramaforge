# 本地版部署策略（System of Record）

> 记于 2026-08-06。本地版 = "云端同一套代码，换本地配置打包"。本文是本地版方向的真相源；
> 代码事实以 repo 为准，本文随实现漂移时复核。

## 1. 决策：一套代码，两种打包

云端版和本地版**共用 `packages/web` + `packages/server` + `packages/client` 一套代码**，差异全是配置/打包，不是代码分叉：

| 维度 | 云端版（CS+云端） | 本地版（单机部署） |
|---|---|---|
| 运行 | 云服务器 | Electron 内嵌本机起服务 |
| DB | 云 Postgres | 本地（bundle PG / 或 SQLite） |
| AI key | 平台池 | **BYOK（用户自带）** |
| 计费 | on | off（flag） |
| license 门禁 | 不需要 | **强制（机器绑定 + 联网激活）** |

→ "同时更新 / 版本一致 / 效果相当" 由结构保证：同一个 commit、同一个 tag 出两个包。

> `packages/local-server` 是**历史包袱**——它手写重写了云端已有的 API（53 路由）。方向是**降级为薄启动器**（起 web + 注入本地配置 + 挂 license），业务逻辑全回 `@dramaforge/server`，删重写。见 §7 待办。

## 2. 可行性已证（spike 2026-08-06）

云端栈原样在本地跑通，未改一行业务代码：

| 验证 | 结果 |
|---|---|
| 本地基础设施 pg+redis+minio（docker） | ✅ 全 healthy |
| 本地 DB（dramaforge） | ✅ 已迁 20 表 |
| 云端 web（Next 全栈）本机启动 | ✅ health `{ok:true}` |
| 业务+编排路由（analyze/storyboard/chain-generate） | ✅ 全 401，零 404/500 |
| DeepSeek 真 key 调用 | ✅ 返 `LOCAL_LLM_OK`（模型 `deepseek-v4-flash` 有效） |
| **web 自带 API（不走 Fastify）登录+业务路由** | ✅ NextAuth 登录→session→`GET /api/projects` 200 `{data:[]}`（本地 DB 真实读写，2026-08-06） |
| **完整 AI 工作流 analyze→generate-storyboard** | ✅ analyze→5 scenes（DeepSeek 52s）、storyboard→20 shots（255s）写入本地 DB（2026-08-07） |

关键：编排路由返回 401（鉴权生效）而非 404/500 = 路由 + 中间件 + 领域代码本地全跑。AI 调用走的是云端 `callDeepSeek` 同一个端点。

## 3. 体积（实测）

| 组件 | 实测 |
|---|---|
| web standalone（`output:'standalone'`，含 UI+服务端） | 52.6 MB |
| local-server（Fastify+SQLite+BYOK+license） | 4.3 MB |
| Electron + client（含 ffmpeg/sharp/音色库） | ~160 MB |
| **本地版安装包合计** | **~220 MB** / 装完 **~400-500 MB** |

走 SQLite 轻方案（无 PG/Redis/MinIO/Python），约 app1（2GB+）的 1/5。
⚠ 注意：`.next` 开发缓存 3.2GB 是 dev cache，**不是**部署体积。

## 4. 防盗版闭环

| 层 | 手段 | 状态 |
|---|---|---|
| 机器绑定 + 联网激活 | license POST `https://your-domain.example.com/api/license`，服务端 Ed25519 签名 + 设备数限制，私钥只在云端 | ✅ |
| 代码保护 | bytenode（JS→V8 字节码） | ✅ 构建期 |
| **AI 调用门禁（统一）** | 共享 `@dramaforge/server` 的 `callAI`：`setLicenseGate` hook + 本地模式首次调用懒加载 license 并注册；local-server 的 `localCallAI` 亦守卫。license 模块已迁入 `@dramaforge/server/license` | ✅ 已写+验证（本地无 license→analyze 秒拦 502，2026-08-07） |
| 机器指纹 | CIM（`Get-CimInstance` CPU/UUID/disk），Win11 无 wmic | ✅ 修完（machineId 跨重启稳定） |

**防"打穿内存"的思路**：不加固内存，而是**秘密不在机器上**——签名私钥只在云端激活服务器，dump 内存最多 patch 一台机的本地校验，伪造不了 license、绕不过激活、挡得住 copy 转卖。

⏸ **缓做**：BYOK key 列加密（防 DB 文件被拷后偷 API key）——次要威胁，代码最多，等真需要再做（最小版只加密 `api_configs.apiKey` 列，不做全库 SQLCipher）。

## 5. 网络边界（本地版只出这几类）

| 出站 | 用途 | 过你的云？ |
|---|---|---|
| `your-domain.example.com/api/license` | 激活/反激活 | ✅ 仅此 |
| `/api/client/update` | 检查新版本 | ✅ 仅此 |
| `api.deepseek.com` / `ark..volces.com` / moonshot 等 | AI 生成（BYOK 直连厂商） | ❌ 不过 |
| DB/资产/ffmpeg | 全本地 | ❌ 不出机 |

无 Sentry / 遥测 / 崩溃上报。AI 调用直连厂商，卖方看不到用户数据，云端不背 AI 流量。

## 6. 本地启动 / 与云端 dev 隔离

[`scripts/run-local-detached.bat`](../scripts/run-local-detached.bat) —— 偏移端口 + 独立数据目录，与 `D:\dramaforge-cs` 云端 dev 零冲突：

- web `127.0.0.1:13000`（dev 用 3000）/ Fastify `17519`（dev 用 docker 5432/6379/9000）
- 数据落 `D:\DramaForgeLocal\data\`（独立 SQLite + storage，不碰 dev 的 docker DB）
- 实测：本地实例 health ok + 自建 SQLite + dev 的 users 仍 1（未动）

## 7. 待办

- [ ] **删 local-server 重写**，降级为薄启动器（起 web + 本地配置 + license 门禁），业务逻辑回 `@dramaforge/server`。最大头的活。
- [ ] BYOK 设置 UI：`components/features/local-mode/ApiKeyPanel.tsx` 已写但**没挂进设置页**；它调的 `/api/api-configs` 路由在 local-server 里，要进共享 web（local-mode flag）。
- [ ] 计费 flag-gating：云端路由散着扣费调用，本地需 `BILLING_ENABLED` 关闭 no-op（去 billing 那条线）。
- [ ] 落地页 `/` 404：`.next` 旧 build，`next build` 重打即修（非架构问题）。
- [ ] （可选）DB 加密、SQLite 瘦身、native 加固——均为"以后真需要再说"。

## 附：关键路径

- 门禁：`packages/server/src/gateway/index.ts`（`callAI` + `setLicenseGate`，本地模式懒加载）
- 指纹/激活/验签：`packages/server/src/license/`（`fingerprint.ts` CIM、`index.ts` 激活、`gate.ts`）—— 已从 local-server 迁入共享层
- 本地构建：`pnpm --filter @dramaforge/web build:standalone`（`scripts/build-standalone.mjs`，配 `next.config.local.mjs`）
- 启动：`scripts/run-local-detached.bat`
