#!/usr/bin/env bash
# =============================================================================
# DramaForge 一键部署脚本（在本地 Git Bash 跑）
# =============================================================================
#
# 用法：cd /d/dramaforge-cs && bash scripts/deploy.sh [tag] [--no-local]
#   tag       可选，默认 = git short sha（如 a1b2c3d）
#   --no-local 跳过本地 precheck 验收（仅应急；默认先本地验过了才推云端）
#
# 流程（绝不在服务器 build）：
#   0. 本地 precheck：typecheck/单测 + docker build + 隔离栈跑迁移/冒烟（--no-local 可跳过）
#   1. 本地 pnpm -r build（web next build + server esbuild bundle）
#   2. 本地 docker build web + ai-worker 镜像（tag = git sha 或传入 tag）
#   3. 从服务器当前运行容器保留上一版作回滚
#   4. docker save | gzip | ssh load（传输镜像，约 1-3 分钟）
#   5. ssh 跑数据库迁移（⑦ migrate runner，幂等可重复）
#   6. 先重启 ai-worker 并确认运行，再重启 web（避免新 Web 派发旧 Worker 不认识的契约）
#   7. 健康检查（curl web 首页 + compose ps 状态）
#
# 服务器：root@YOUR_SERVER
# 远程目录：/opt/dramaforge（需提前放好 docker-compose.yml + .env）
# SSH key：~/.ssh/deploy_key
# =============================================================================
set -euo pipefail
# Git-Bash 会话若设置了 MSYS_NO_PATHCONV/MSYS2_ARG_CONV_EXCL，node/pnpm 等 Windows
# 程序收到的 /c/... 参数不会转成盘符路径而报 MODULE_NOT_FOUND；部署链路必须用 POSIX 转换。
unset MSYS_NO_PATHCONV MSYS2_ARG_CONV_EXCL 2>/dev/null || true
cd "$(dirname "$0")/.."

SERVER="${SERVER:-root@YOUR_SERVER}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/deploy_key}"
REMOTE_DIR="${REMOTE_DIR:-/opt/dramaforge}"
SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no $SERVER"

# 镜像 tag：优先用参数，否则用 git short sha，最后兜底用日期。
# 单独保存为 DEPLOY_TAG，防止后续 source .env 时其中的 TAG 覆盖命令行版本。
# 参数解析：[tag] [--no-local]（--no-local 跳过本地 precheck，仅应急用）。
NO_LOCAL=0
DEPLOY_TAG=""
for _a in "$@"; do
  case "$_a" in
    --no-local) NO_LOCAL=1 ;;
    --*) echo "❌ 未知参数: $_a（用法: bash scripts/deploy.sh [tag] [--no-local]）"; exit 2 ;;
    *) DEPLOY_TAG="$_a" ;;
  esac
done
DEPLOY_TAG="${DEPLOY_TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d-%H%M%S)}"
TAG="$DEPLOY_TAG"
IMAGE_WEB=dramaforge-cs-web
IMAGE_WORKER=dramaforge-cs-ai-worker

echo "=== 部署 tag: $TAG ==="

# ---------------------------------------------------------------------------
# [0/8] 本地部署前验收（precheck）— 默认开启；--no-local 跳过（仅应急）。
#   用与生产同一 Dockerfile 本地 build + 起隔离栈跑迁移/冒烟，过了才推云端。
#   验的是 build/迁移/boot/路由/崩溃类（历史上多数生产事故的类别）；AI 真实生成
#   仍需部署后云端冒烟。precheck 用本 tag build，验过的镜像 deploy 直接复用（缓存命中）。
# ---------------------------------------------------------------------------
if [ "$NO_LOCAL" = "0" ]; then
  echo "=== [0/8] 本地部署前验收 (precheck；--no-local 可跳过) ==="
  bash scripts/precheck.sh "$TAG" || {
    echo "❌ precheck 失败，部署中止。排查后重试，或应急用: bash scripts/deploy.sh $TAG --no-local"
    exit 1
  }
  echo "  precheck 通过，继续推云端。"
else
  echo "=== [0/8] ⚠ 跳过本地验收 (--no-local)，直接推云端 ==="
fi

# ---------------------------------------------------------------------------
# [1/8] 本地构建（pnpm -r build）
#   - packages/web: next build → .next/
#   - packages/server: esbuild bundle → dist/ai-worker/index.js + dist/migrate.js
#   - packages/shared: 无 build（纯 TS，被 web/server 直接引用）
#   - packages/client: 不参与云端部署（Electron 桌面端单独打包）
# ---------------------------------------------------------------------------
echo "=== [1/8] 本地 pnpm -r build ==="
# next build 收集 page data 触发 env() 校验，需 .env 在场（仅校验存在性，不影响产物：
# 非 NEXT_PUBLIC_ 变量不 bake）。docker build 内另有 placeholder ENV 兜底。
if [ -f .env ]; then set -a; . ./.env; set +a; fi
# .env 只提供构建所需配置，部署身份必须始终服从本次命令行参数。
TAG="$DEPLOY_TAG"
pnpm -r --filter '@dramaforge/web' --filter '@dramaforge/server' build

# ---------------------------------------------------------------------------
# [2/8] 本地 docker build（web + ai-worker）
#   build context = 仓库根，Dockerfile 在各 packages/ 下
#   web:       docker build -f packages/web/Dockerfile -t dramaforge-cs-web:$TAG .
#   ai-worker: docker build -f packages/server/Dockerfile -t dramaforge-cs-ai-worker:$TAG .
# ---------------------------------------------------------------------------
echo "=== [2/8] 本地 docker build web + ai-worker ==="
docker build -f packages/web/Dockerfile -t "$IMAGE_WEB:$TAG" -t "$IMAGE_WEB:latest" .
docker build -f packages/server/Dockerfile -t "$IMAGE_WORKER:$TAG" -t "$IMAGE_WORKER:latest" .

# ---------------------------------------------------------------------------
# [3/8] 服务器保留上一版作回滚
#   必须以当前运行容器的镜像 ID 为准；latest 可能因旧版部署流程没有同步而陈旧。
# ---------------------------------------------------------------------------
echo "=== [3/8] 服务器保留上一版作回滚 ==="
$SSH "CURRENT_ID=\$(docker inspect -f '{{.Image}}' dramaforge-web 2>/dev/null || true); if [ -n \"\$CURRENT_ID\" ]; then docker tag \"\$CURRENT_ID\" $IMAGE_WEB:rollback; else docker tag $IMAGE_WEB:latest $IMAGE_WEB:rollback 2>/dev/null || true; fi"
$SSH "CURRENT_ID=\$(docker inspect -f '{{.Image}}' dramaforge-ai-worker 2>/dev/null || true); if [ -n \"\$CURRENT_ID\" ]; then docker tag \"\$CURRENT_ID\" $IMAGE_WORKER:rollback; else docker tag $IMAGE_WORKER:latest $IMAGE_WORKER:rollback 2>/dev/null || true; fi"

# ---------------------------------------------------------------------------
# [4/8] 传输 + 加载新镜像（docker save | gzip | ssh docker load）
#   两个镜像分别传输，约 1-3 分钟/个
# ---------------------------------------------------------------------------
echo "=== [4/8] 传输 + 加载新镜像（约 1-3 分钟/镜像）==="
echo "  -> web..."
docker save "$IMAGE_WEB:$TAG" | gzip | $SSH "docker load"
echo "  -> ai-worker..."
docker save "$IMAGE_WORKER:$TAG" | gzip | $SSH "docker load"

# docker save 只携带显式保存的 :$TAG；远端补齐 latest，保证下次部署与 rollback.sh
# 看到的“当前版本”始终与本次实际启动的镜像一致。
$SSH "docker tag $IMAGE_WEB:$TAG $IMAGE_WEB:latest"
$SSH "docker tag $IMAGE_WORKER:$TAG $IMAGE_WORKER:latest"

# ---------------------------------------------------------------------------
# [5/8] 跑数据库迁移（幂等，可安全重复执行）
#   通过 migrate profile 运行一次性容器
#   dist/migrate.js 由 packages/server esbuild bundle 产出
# ---------------------------------------------------------------------------
echo "=== [5/8] 跑数据库迁移（幂等）==="
$SSH "cd $REMOTE_DIR && TAG=$TAG docker compose --profile migrate run --rm migrate"

# ---------------------------------------------------------------------------
# [6/8] 先 worker、后 web 滚动重启（用新镜像）
#   --no-build 确保不触发 compose build，直接用已加载的镜像。
#   worker 先升级可保证 Web 切换后，提示词快照/变体等新任务契约已有消费者。
# ---------------------------------------------------------------------------
echo "=== [6/8] 滚动重启：ai-worker -> web ==="
$SSH "cd $REMOTE_DIR && TAG=$TAG docker compose up -d --no-build ai-worker"
$SSH "for i in \$(seq 1 20); do STATE=\$(docker inspect -f '{{.State.Status}}' dramaforge-ai-worker 2>/dev/null || true); [ \"\$STATE\" = running ] && exit 0; sleep 1; done; docker logs --tail 80 dramaforge-ai-worker; exit 1"
$SSH "cd $REMOTE_DIR && TAG=$TAG docker compose up -d --no-build web"

# ---------------------------------------------------------------------------
# [7/8] 健康检查
#   等待 10s 让容器启动，检查 compose ps 状态 + /api/health。
#   curl --fail 让非 2xx 或连接失败直接终止部署，不能只打印状态码后继续。
# ---------------------------------------------------------------------------
echo "=== [7/8] 健康检查 ==="
sleep 10
$SSH "cd $REMOTE_DIR && docker compose ps --format '{{.Name}}  {{.Status}}'"
$SSH "cd $REMOTE_DIR && set -a && . ./.env && set +a && curl --fail --silent --show-error --retry 15 --retry-delay 2 --retry-connrefused --max-time 10 http://127.0.0.1:\${WEB_PORT:-3000}/api/health"

# ---------------------------------------------------------------------------
# [8/8] 清理旧镜像 tag（防磁盘累积 → postgres recovery loop，本次 P0 事故根因）
#   每次部署累积历史 sha tag（本次事故 15+ tag ~12GB 撑爆磁盘 100%）。
#   只保留 latest（当前）+ rollback（回滚锚）+ 本次 TAG，删其余历史 tag。
#   不碰 dramaforge-cs 之外的其他镜像（如 app1 dramaforge-studio）。
#   安全性：新容器已在 [6/8] 用 :TAG 起来，且远端 latest 已同步到同一镜像；
#           本次 TAG 也排除，避免误删当前镜像实体。
# ---------------------------------------------------------------------------
echo "=== [8/8] 清理旧镜像 tag（只留 latest + rollback + 本次 TAG）==="
$SSH TAG="$TAG" bash -s <<'REMOTE'
  set -e
  for IMG in dramaforge-cs-web dramaforge-cs-ai-worker; do
    docker images "$IMG" --format '{{.Tag}}' \
      | grep -vE "^(latest|rollback|${TAG})$" \
      | while read -r oldtag; do
          [ -n "$oldtag" ] && { docker rmi "$IMG:$oldtag" 2>/dev/null || true; }
        done
  done
  docker image prune -f 2>/dev/null || true
  echo "  清理后 dramaforge 镜像："
  docker images --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' | grep dramaforge-cs || true
REMOTE

echo ""
echo "✅ 部署完成 (tag: $TAG)。出问题回滚: bash scripts/rollback.sh"
