# DramaForge 版本更新 Runbook

> 两条独立更新通道 + 一次性 cutover。服务器 `root@YOUR_SERVER` (your-domain.example.com)。
> 所有脚本在本地 Git Bash 跑：`cd /d/dramaforge-cs`。SSH key `~/.ssh/deploy_key`。
> 设计 spec：`docs/superpowers/specs/2026-07-18-cs-refactor-design.md`。进度日志：`archive/WORKLOG.md`。

## 架构速览

- **云服务器**（docker-compose，总 1280m RAM）：`web`(Next.js,:3000 唯一对外) + `ai-worker`(纯 AI BullMQ) + `postgres`/`redis`/`minio`(internal-only，不暴露公网)。**ffmpeg 不在服务器**。
- **桌面客户端**：Electron 薄壳加载 `https://your-domain.example.com` + 本机 ffmpeg（render-worker HTTP 拉取 render_jobs）。
- **两条更新通道**（互不影响）：
  - **服务器**：改后端/web 代码 → `deploy.sh`（容器镜像滚动 + DB 迁移，零停机）
  - **客户端**：改 Electron 代码 → 打包 .exe → `publish-client.sh`（更新 manifest + ⑭ 静默拉取）
- **3 个运维骨架**：⑬ 心跳(30s,断代 force_upgrade) / ⑭ 静默下载器(轮询 /api/client/update) / ⑮ 本地日志+懒上报。

---

## 1. 服务器更新（`deploy.sh`）— 零停机

改了 `packages/web` 或 `packages/server` 代码后：

```bash
cd /d/dramaforge-cs
git add -A && git commit -m "fix/feat: ..."
bash scripts/deploy.sh           # tag 默认 = git short sha；或 bash scripts/deploy.sh v0.0.2
```

**`deploy.sh` 7 步**（绝不在服务器 build，避免 1.8GB OOM）：
1. 本地 `pnpm -r build`（web next build + server esbuild bundle）。读 `.env` 供 next build 的 env() 校验。
2. 本地 `docker build` web + ai-worker 镜像（tag=sha，同时打 latest）。
3. 服务器把当前 `latest` 重打 `rollback`（保留上一版）。
4. `docker save | gzip | ssh load` 传两个镜像（~1-3min/个）。
5. ssh 跑 `migrate` profile（⑦ migrate runner，幂等可重复，`_migrations` 表追踪）。
6. `docker compose up -d --no-build`（用新镜像重启 web/ai-worker，pg/redis/minio 不动）。
7. 健康检查（compose ps + curl web 首页）。

**回滚**（应用镜像层，DB 不回退）：
```bash
bash scripts/rollback.sh
```
把 `rollback` tag 重打 `latest` + compose up。⚠️ **数据库迁移不回退**（迁移只增不减，`_migrations` 追踪）。若新版加了列/表，回滚到旧镜像通常无害（旧代码忽略多余列）；若删了列/改了类型，需手写 DOWN 迁移 SQL。

**加 DB 迁移**：新 SQL 文件放 `packages/server/src/infra/migrations/000N-foo.sql`（`CREATE TABLE IF NOT EXISTS` / 幂等），deploy.sh [5] 自动跑。

---

## 2. 客户端更新（`publish-client.sh`）— 静默推送

改了 `packages/client` 代码后：

```bash
cd /d/dramaforge-cs
# 1. 改 package.json version（如 0.0.0 → 0.0.1）
# 2. 构建 + 打包（必须带镜像 env，否则 winCodeSign/nsis 从 github 下载超时）
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
pnpm --filter @dramaforge/client build:main
pnpm --filter @dramaforge/client package
# 产物：packages/client/release/DramaForge-<version>-x64.exe

# 3. 发布到生产（dramaforge 需已 cutover）
bash scripts/publish-client.sh 0.0.1           # 软提示更新（minVersion 不变）
bash scripts/publish-client.sh 0.0.1 --force   # 强制淘汰旧版（minVersion=0.0.1 → ⑬ force_upgrade 锁死）
```

**`publish-client.sh` 流程**：
1. scp .exe → 服务器 `/opt/dramaforge/client-releases/`（nginx `/downloads/` 托管）。
2. 读服务器 `.env` 拿 `POSTGRES_USER/DB`。
3. `docker exec dramaforge-postgres psql` 更新 `system_configs.CLIENT_VERSIONS_MANIFEST`（PG dollar-quoting `$JSON$` 避免 JSON 转义）。manifest 形状（对准 `packages/web/lib/versions.ts`）：`{minVersion, latestVersion, downloadUrls:{win,mac,linux}}`。
4. curl 验证 `https://your-domain.example.com/downloads/DramaForge-<ver>-x64.exe` → 200。

**生效机制**：
- 现有客户端 ⑭ updater 下次轮询 `/api/client/update` → 拉到新 `latestVersion` → 静默下载到 `userData/updates` → 提示重启。
- `--force`：`minVersion` 提到 `<version>` → 旧版客户端 ⑬ 心跳收到 `force_upgrade` → UI 锁死直到升级。

---

## 3. 一次性 Cutover（app1 → dramaforge）— 停机 + 不可逆

**仅在首次上线用一次**。前提：① 服务器镜像预 build 好 ② `/opt/dramaforge` 预置好 ③ 迁移 dry-run 过 ④ **4 个用户已装好 .exe**（cutover 后 middleware 拦浏览器，没 .exe 进不去 your-domain.example.com）。

```bash
bash scripts/cutover.sh        # 停机约 5-10 分钟
bash scripts/rollback-cutover.sh   # dramaforge 起不来时回退
```

**`cutover.sh` 9 步**（停机 = [2]→[8]）：
1. 预检：app1 在跑 / dramaforge 镜像本地就位 / dramaforge 容器未跑。
2. 停 app1 `sf-web`+`sf-worker`（释放 :3000；**保留 pg/redis** 以便 dump 一致快照）。
3. `migrate-app1-data.sh dump` → `scripts/app1-data.sql`（app1 无新写入，快照一致）。
4. 停 app1 `sf-postgres`+`sf-redis`（释放全部 app1 RAM，~747MB）。
5. `docker save | gzip | ssh load` 传 dramaforge 镜像（~2-4min）。
6. 起 dramaforge pg/redis/minio + migrate（建空 schema + render_jobs）。
7. `migrate-app1-data.sh restore prod` → dramaforge pg（TRUNCATE + dump 还原，已 dry-run 验证 14 表行数全对）。
8. 起 dramaforge web + ai-worker（绑 :3000；nginx 一直路由 :3000，无需改）。
9. 验证：compose ps + 内网/HTTPS `/api/health`。

**app1 容器仅 stop 不 remove**——保留以便 rollback。

**`rollback-cutover.sh`**：dramaforge 全部 down → 起 app1（sf-postgres/redis/web/worker）。nginx 路由 :3000 → app1 自动接管。
- ⚠️ app1 数据是 cutover [3] dump 时刻快照；**dramaforge 运行期间的增量数据会丢失**（回滚即放弃 dramaforge 侧新增）。
- dramaforge 的 pg/redis/minio 数据卷（`dramaforge_pg_data` 等）保留不删，便于排查。

**cutover 后手动验证项**：① Electron 客户端用迁移用户登录 ② 旧项目 `/uploads/` 图片可加载（app1 uploads 只读挂载到 dramaforge） ③ 跑一个 FILM_EXPORT 确认客户端 ffmpeg + render-job 链路。

---

## 4. 首次客户端发布前的一次性准备（nginx `/downloads/`）

`publish-client.sh` 需要 nginx 托管 `/downloads/` 静态目录。cutover 后、首次 `publish-client.sh` 前加一次：

```nginx
# 在 /etc/nginx/sites-available/dramaforge.conf 的 server 块里加：
location /downloads/ {
    alias /opt/dramaforge/client-releases/;
    autoindex off;
}
```
然后 `sudo nginx -t && sudo nginx -s reload`。
（此 location 是静态文件，与 `proxy_pass :3000` 互不影响；浏览器也能下 .exe，无妨——.exe 本就公开。）

---

## 5. 已知 gap / TODO

| 项 | 状态 | 说明 |
|---|---|---|
| bytenode .jsc 保护 | 跳过 | 首版 plain .js（`dist-main/index.js` 可读）。Electron 43 的 .jsc V8 兼容未验；需时跑 `scripts/protect.mjs`（`electronMain:true`）+ 验 .jsc 加载。 |
| `build/icon.ico` | 缺 | electron-builder 用默认 Electron 图标。提供 `packages/client/build/icon.png`（≥512x512）后启用 yml `win.icon`。 |
| userData 路径名 | cosmetic | 当前 `%APPDATA%\@dramaforge\client\`（从 package.json name），非 productName "DramaForge CS"。功能无影响。4 用户装前可加 `app.setName('DramaForge CS')` 统一（零迁移成本）；装后改会让 machine-id/缓存失效。 |
| nsis `oneClick:false` | 首版 OK | 交互式装（4 用户手动装）。接 ⑭ 静默自动更新时可能改 `oneClick:true` + `/S` 静默装，或改 portable 由 ⑭ 自换。 |
| middleware UA 屏障 | 软屏障 | 非 Electron UA 访问页面 → 302 `/download`；`/api/*` 全放行（避免误伤 render-worker bare-fetch）。UA 可伪造，真边界是认证（JWT+单设备踢人）。后续叠 HMAC attestation 硬化。 |

---

## 速查：日常两种更新

| 改了什么 | 怎么发 |
|---|---|
| 后端/web（packages/web, packages/server） | `git commit` → `bash scripts/deploy.sh` |
| Electron 客户端（packages/client） | 改 version → `build:main` + `package` → `bash scripts/publish-client.sh <ver> [--force]` |
| DB schema | 加 `migrations/000N-*.sql` → `bash scripts/deploy.sh`（[5] 自动跑） |
| 两者都改 | 先 `deploy.sh`（服务器），再 `publish-client.sh`（客户端），独立无依赖 |
