#!/usr/bin/env bash
# ============================================================
# rollback-cutover.sh — dramaforge 起不来时回退到 app1
# ============================================================
# 停 dramaforge 全部容器 → 起 app1（sf-web/worker/redis/postgres）。
# nginx 一直路由 :3000，app1 sf-web 起来后自动接管。
#
# ⚠️ 数据说明：
#   - app1 数据是 cutover [3] dump 时刻的快照（切换前最终状态）。
#   - dramaforge 运行期间产生的新数据（若有）会丢失——回滚即放弃 dramaforge 侧增量。
#   - dramaforge 的 pg/redis/minio 数据（named volumes）保留，不删除，便于排查。
#
# 用法：bash scripts/rollback-cutover.sh
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER=root@YOUR_SERVER
SSH_KEY="$HOME/.ssh/deploy_key"
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SERVER")

echo "=== 停 dramaforge 全部容器 ==="
"${SSH[@]}" "cd /opt/dramaforge && docker compose down 2>/dev/null || true"

echo "=== 起 app1（sf-postgres/redis/web/worker）==="
"${SSH[@]}" "docker start sf-postgres sf-redis sf-web sf-worker 2>/dev/null || true"
echo "  -> 等 app1 起来（12s）..."
sleep 12

echo "=== 验证 ==="
"${SSH[@]}" "docker ps --format '{{.Names}}  {{.Status}}' | grep -E '^sf-'"
"${SSH[@]}" "curl -s -o /dev/null -w '  app1 内网 /: HTTP %{http_code}\n' --max-time 10 http://127.0.0.1:3000/"
"${SSH[@]}" "curl -s -o /dev/null -w '  app1 HTTPS /: HTTP %{http_code}\n' --max-time 10 https://your-domain.example.com/"
echo ""
echo "✅ 回滚到 app1。dramaforge 数据卷保留（dramaforge_pg_data 等）便于排查。"
