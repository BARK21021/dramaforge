# dramaforge CUTOVER Runbook（2026-07-21，6 批攒批上线）

## 前置验证（已完成 ✅）
- **typecheck**：server 0 错 / client 0 错 / web 仅 pre-existing `sms-security.test.ts` 7 错（RequestInit/signal/NODE_ENV，无关）
- **vitest**：server 521 pass（修了 ENTITY 断言）/ client 190 pass / web 311 pass，**零新 fail**
- **web production build**：exit 0，所有新 route 进 bundle（`rename`/`chain-generate`/costume UI/音色 UI/generate-text FormData）
- 6 批功能全部实现，跨 6 个 agent 文件叠加零冲突（service.ts / AssetDesignStage.tsx / sf-shell.d.ts 等多重 edit 都正确合并）

## ⚠ 关键：批1 契约同步（最重要）
`generate-text` 从 JSON 改 multipart/form-data（转绘 OOM 修复）。**server + client 必须同步部署**——先发哪个都让另一端坏（旧 client 发 JSON 撞新 server FormData 解析；新 client 发 FormData 撞旧 server JSON 解析）。deploy.sh 只部署 server，client exe 单独打包，两者发布要紧挨着。

## 步骤

### 0. nginx 媒体流式前置（生产当前尚未应用）

生产 `/etc/nginx/conf.d/dramaforge.conf` 当前仍使用 nginx 默认请求缓冲。部署前把
`scripts/nginx/dramaforge-media-streaming.inc` 放到服务器，并在
`your-domain.example.com` 的 `server {}` 内 `include`；随后只在 `nginx -t` 通过后 reload。
该配置只影响资产参考图上传和一次性媒体接力地址，使客户端 → Next → AI 供应商走
背压数据流，不在 1.8GB 服务器上整块缓存。应用层仍保留限长、串行 base64 兼容回退。

### 1. server 部署（一键）
```bash
cd /d/dramaforge-cs && bash deploy.sh
```
自动：本地 `pnpm -r build`（web next build + server esbuild）→ 本地 docker build web+ai-worker → 服务器保留 rollback tag → `docker save|gzip|ssh load` 传镜像 → ssh 跑 migrate（幂等）→ `docker compose up -d --no-build` → 健康检查（curl /api/health + compose ps）。
- 服务器 `root@YOUR_SERVER`，SSH `~/.ssh/deploy_key`，远程 `/opt/dramaforge`
- **DB 无新 migration**：`gridOverlayEnabled`/`pencilPaintEnabled`/`costumes`/`voiceId`/`voiceSource` 列 `0001-init.sql` 已存在；rename-service 不加列只 UPDATE。migrate profile 跑现有迁移幂等确认即可。

### 2. client repackage（仅在需要重新出安装包时执行，版本不升）
```bash
cd /d/dramaforge-cs/packages/client && pnpm build && pnpm package
```
- 客户端 `package.json` 保持 `1.1.6`；本轮不改版本号。若重新打包，产物仍应为 `DramaForge-1.1.6-x64.exe`。

### 2b. client 发布到生产（publish-client.sh）— 等 server deploy 完成后执行
```bash
cd /d/dramaforge-cs && bash scripts/publish-client.sh 1.1.6
```
scp exe → 服务器 `/opt/dramaforge/client-releases/` + 更新 `CLIENT_VERSIONS_MANIFEST`（latestVersion=1.1.6）+ curl 验证 200。只有确实重新发布安装包时才执行本步。
- **不加 --force**：版本仍为 1.1.6，本轮不通过版本号强制淘汰现有客户端。

### 3. 同步发布
- deploy.sh 完成 + client exe 放更新源，**尽量同时**（批1 契约）
- 用户客户端通过 updater 自动拉新 exe

### 4. 验证清单（逐项过）
- [ ] 登录 + 落地页正常
- [ ] **转绘流式**（批1）：上传视频 → 分段 → 生成剧本，大视频不 OOM（FormData 单缓冲）
- [ ] **图片上传**（批2）：资产卡上传/换图，落地 sf-asset://
- [ ] **资产重命名**（批3）：改角色名 → 分镜/对白/coverageScenes/relationships 等 6 表同步更新
- [ ] **costume 变体**（批4）：CHARACTER 造型变体区，变装基于基准图 i2i 生图
- [ ] **稀疏网格**（批5）：CHARACTER 开 gridOverlayEnabled + 有图 → 视频生成时叠稀疏九宫格参考
- [ ] **音色库**（批6）：浏览 200 音色（性别筛选）+ 试听 + 绑定（voiceSource=library）+ AI 提取时建议音色（metadata.suggested_voices）

### 5. 回滚
- **server**：`bash rollback.sh`（deploy.sh [3/7] 已把上版 tag 为 rollback）
- **client**：退旧 exe（关 updater 或手动装旧版）

## 待用户回来确认
- [ ] 生产部署执行（outward-facing，等确认或授权我跑）
- [ ] client exe 变大 ~44MB，用户更新下载量可接受
- [ ] 音色库 200wav license 已确认（用户说有）
