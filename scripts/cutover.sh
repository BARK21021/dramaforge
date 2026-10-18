#!/usr/bin/env bash
# ============================================================
# cutover.sh — app1 → dramaforge 生产切换（停机窗口，不可逆）
# ============================================================
# 前提：
#   - #27 预 build 完成：本地有 dramaforge-cs-web:latest + dramaforge-cs-ai-worker:latest
#   - #26 bootstrap 完成：/opt/dramaforge 有 compose + .env + override
#   - scripts/migrate-app1-data.sh 就位
#
# 停机窗口（downtime 从 [2] 到 [8] 完成）：
#   [1] 预检：app1 在跑 / dramaforge 镜像本地就位 / dramaforge 容器未跑
#   [2] 停 app1 web+worker（释放 :3000；保留 pg/redis 以便 dump 一致快照）
#   [3] dump app1 最终数据 → scripts/app1-data.sql（app1 无新写入，快照一致）
#   [4] 停 app1 pg+redis（释放全部 app1 RAM，约 747MB）
#   [5] load dramaforge 镜像到服务器（save|gzip|ssh load，~2-4min）
#   [6] 起 dramaforge pg/redis/minio + migrate（建空 schema + render_jobs）
#   [7] restore app1 数据 → dramaforge pg（TRUNCATE + dump 还原，已 dry-run 验证）
#   [8] 起 dramaforge web + ai-worker（web 绑 :3000；nginx 已路由，无需改）
#   [9] 验证：compose ps + /api/health（内网+HTTPS）
#
# app1 容器仅 stop 不 remove——保留以便 rollback-cutover.sh 回退。
# 回滚：bash scripts/rollback-cutover.sh
#
# ⚠️ 不可逆 + 停机。必须用户确认窗口后手动执行。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."   # 仓库根

SERVER=root@YOUR_SERVER
SSH_KEY="$HOME/.ssh/deploy_key"
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SERVER")

echo "=== [1/9] 预检 ==="
"${SSH[@]}" "docker ps --format '{{.Names}}' | grep -q '^sf-web$' && echo '  app1 sf-web: UP' || { echo '❌ app1 sf-web 未运行'; exit 1; }"
docker image inspect dramaforge-cs-web:latest >/dev/null 2>&1 && echo '  local web image: OK' || { echo '❌ 本地无 dramaforge-cs-web:latest，先跑预 build'; exit 1; }
docker image inspect dramaforge-cs-ai-worker:latest >/dev/null 2>&1 && echo '  local ai-worker image: OK' || { echo '❌ 本地无 dramaforge-cs-ai-worker:latest'; exit 1; }
"${SSH[@]}" "docker ps --format '{{.Names}}' | grep -q '^dramaforge-' && { echo '❌ dramaforge 容器已在跑（cutover 假设 dramaforge 未起）'; exit 1; } || echo '  dramaforge not running: OK'"
echo "  预检通过"

echo "=== [2/9] 停 app1 web+worker（保 pg/redis 以便 dump）==="
"${SSH[@]}" "docker stop sf-web sf-worker 2>/dev/null || true"

echo "=== [3/9] dump app1 最终数据（一致快照）==="
bash scripts/migrate-app1-data.sh dump

echo "=== [4/9] 停 app1 pg+redis（释放 RAM）==="
"${SSH[@]}" "docker stop sf-postgres sf-redis 2>/dev/null || true"

echo "=== [5/9] load dramaforge 镜像到服务器（~2-4min）==="
echo "  -> web..."
docker save dramaforge-cs-web:latest | gzip | "${SSH[@]}" "docker load" | tail -1
echo "  -> ai-worker..."
docker save dramaforge-cs-ai-worker:latest | gzip | "${SSH[@]}" "docker load" | tail -1

echo "=== [6/9] 起 dramaforge pg/redis/minio + migrate ==="
"${SSH[@]}" "cd /opt/dramaforge && docker compose up -d postgres redis minio"
echo "  -> 等基础设施 healthy（20s）..."
sleep 20
"${SSH[@]}" "cd /opt/dramaforge && docker compose --profile migrate run --rm migrate"

echo "=== [7/9] restore app1 数据 → dramaforge pg ==="
bash scripts/migrate-app1-data.sh restore prod

echo "=== [8/9] 起 dramaforge web + ai-worker（绑 :3000）==="
"${SSH[@]}" "cd /opt/dramaforge && docker compose up -d --no-build"
echo "  -> 等 web 起来（12s）..."
sleep 12

echo "=== [9/9] 验证 ==="
"${SSH[@]}" "cd /opt/dramaforge && docker compose ps --format '{{.Name}}  {{.Status}}'"
"${SSH[@]}" "curl -s -o /dev/null -w '  内网 /api/health: HTTP %{http_code}\n' --max-time 10 http://127.0.0.1:3000/api/health"
"${SSH[@]}" "curl -s -o /dev/null -w '  HTTPS /api/health: HTTP %{http_code}\n' --max-time 10 https://your-domain.example.com/api/health"
echo ""
echo "✅ cutover 完成。app1 容器已 stop（保留以便 rollback-cutover.sh）。"
echo "   手动验证项：① Electron 客户端用迁移用户登录 ② 旧项目 /uploads/ 图片可加载 ③ 一个 FILM_EXPORT"
