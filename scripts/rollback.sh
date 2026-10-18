#!/usr/bin/env bash
# =============================================================================
# DramaForge 回滚脚本（在本地 Git Bash 跑）
# =============================================================================
#
# 用法：cd /d/dramaforge-cs && bash scripts/rollback.sh
#
# 回滚到上一版应用镜像（deploy.sh [3/7] 步骤保存的 rollback tag）。
#
# ⚠️ 警告：数据库迁移不回退！
#   - 迁移是幂等且只增不减的（_migrations 表追踪已执行文件名）。
#   - 如果新版本加了列/表，回滚到旧镜像后旧代码不认识新列——通常无害
#     （旧代码忽略多余列），但若新版本删了列/改了类型，回滚可能出错。
#   - 如需回退迁移，需手动写 DOWN 迁移 SQL 并在服务器执行。
#
# 服务器：root@YOUR_SERVER
# 远程目录：/opt/dramaforge
# SSH key：~/.ssh/deploy_key
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER=root@YOUR_SERVER
SSH_KEY="$HOME/.ssh/deploy_key"
REMOTE_DIR=/opt/dramaforge
SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no $SERVER"

IMAGE_WEB=dramaforge-cs-web
IMAGE_WORKER=dramaforge-cs-ai-worker

echo "=== 回滚到上一版（rollback tag）==="

# 检查 rollback 镜像是否存在，不存在则报错退出
$SSH "docker image inspect $IMAGE_WEB:rollback >/dev/null 2>&1 || { echo '❌ 没有 $IMAGE_WEB:rollback 回滚镜像（首次部署无旧版）'; exit 1; }"
$SSH "docker image inspect $IMAGE_WORKER:rollback >/dev/null 2>&1 || { echo '❌ 没有 $IMAGE_WORKER:rollback 回滚镜像（首次部署无旧版）'; exit 1; }"

# 将 rollback tag 重新打为 latest，compose 用 latest 启动
$SSH "docker tag $IMAGE_WEB:rollback $IMAGE_WEB:latest"
$SSH "docker tag $IMAGE_WORKER:rollback $IMAGE_WORKER:latest"

# 用回滚镜像重启（--no-build 确保不触发 build）
echo "=== 重启 web/ai-worker（回滚镜像）==="
$SSH "cd $REMOTE_DIR && docker compose up -d --no-build"

# 健康检查
sleep 10
echo "=== 回滚后状态 ==="
$SSH "cd $REMOTE_DIR && docker compose ps --format '{{.Name}}  {{.Status}}'"
$SSH "curl -s -o /dev/null -w 'web HTTP %{http_code}\n' --max-time 10 http://127.0.0.1:\${WEB_PORT:-3000}/"

echo "✅ 回滚完成（注意：数据库迁移不会回退，只回退应用镜像）"
