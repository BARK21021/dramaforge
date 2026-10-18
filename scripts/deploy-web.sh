#!/usr/bin/env bash
# =============================================================================
# DramaForge 仅 web 部署（本地 Git Bash 跑）
# =============================================================================
# 用途：只改了 packages/web 时用，避免重启 ai-worker 打断在跑的渲染任务。
# 流程照搬 deploy.sh 的 web 部分（含 DEPLOY_TAG 保护，防 .env TAG=latest 覆盖）。
#   1. 本地 pnpm build web
#   2. 本地 docker build web
#   3. 服务器保留上一版作 rollback + 传输新镜像
#   4. 仅重启 web
#   5. 健康检查
#   6. 清理旧 web tag
# 用法：cd /d/dramaforge-cs && bash scripts/deploy-web.sh [tag]
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER="${SERVER:-root@YOUR_SERVER}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/deploy_key}"
REMOTE_DIR="${REMOTE_DIR:-/opt/dramaforge}"
SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no $SERVER"

# 单独保存 DEPLOY_TAG，防止后续 source .env 时其中的 TAG=latest 覆盖命令行版本。
DEPLOY_TAG="${1:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d-%H%M%S)}"
TAG="$DEPLOY_TAG"
IMAGE_WEB=dramaforge-cs-web

echo "=== web-only 部署 tag: $TAG ==="

echo "=== [1/6] 本地 build web ==="
if [ -f .env ]; then set -a; . ./.env; set +a; fi
# .env 的 TAG=latest 不能覆盖本次命令行 tag。
TAG="$DEPLOY_TAG"
pnpm -r --filter '@dramaforge/web' build

echo "=== [2/6] 本地 docker build web:$TAG ==="
docker build -f packages/web/Dockerfile -t "$IMAGE_WEB:$TAG" -t "$IMAGE_WEB:latest" .

echo "=== [3/6] rollback tag + 传输镜像 ==="
$SSH "CURRENT_ID=\$(docker inspect -f '{{.Image}}' dramaforge-web 2>/dev/null || true); if [ -n \"\$CURRENT_ID\" ]; then docker tag \"\$CURRENT_ID\" $IMAGE_WEB:rollback; else docker tag $IMAGE_WEB:latest $IMAGE_WEB:rollback 2>/dev/null || true; fi"
echo "  -> 传输 web 镜像..."
docker save "$IMAGE_WEB:$TAG" | gzip | $SSH "docker load"
$SSH "docker tag $IMAGE_WEB:$TAG $IMAGE_WEB:latest"

echo "=== [4/6] 仅重启 web（不动 ai-worker）==="
$SSH "cd $REMOTE_DIR && TAG=$TAG docker compose up -d --no-build web"

echo "=== [5/6] 健康检查 ==="
sleep 8
$SSH "cd $REMOTE_DIR && docker compose ps --format '{{.Name}}  {{.Status}}' | grep -E 'dramaforge-(web|ai-worker)' || true"
$SSH "cd $REMOTE_DIR && set -a && . ./.env && set +a && curl --fail --silent --show-error --retry 15 --retry-delay 2 --retry-connrefused --max-time 10 http://127.0.0.1:\${WEB_PORT:-3000}/api/health"

echo "=== [6/6] 清理旧 web tag（只留 latest + rollback + 本次 TAG）==="
$SSH TAG="$TAG" bash -s <<'REMOTE'
  set -e
  docker images "dramaforge-cs-web" --format '{{.Tag}}' \
    | grep -vE "^(latest|rollback|${TAG})$" \
    | while read -r oldtag; do
        [ -n "$oldtag" ] && { docker rmi "dramaforge-cs-web:$oldtag" 2>/dev/null || true; }
      done
  docker image prune -f 2>/dev/null || true
  echo "  清理后 web 镜像："
  docker images --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' | grep 'dramaforge-cs-web' || true
REMOTE

echo ""
echo "✅ web-only 部署完成 (tag: $TAG)"
