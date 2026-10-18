#!/usr/bin/env bash
# ============================================================
# provision-nginx-minio.sh — 部署 MinIO 公网入口 nginx server_block
# ============================================================
# 把 scripts/nginx/minio-your-domain.conf 部署到服务器
# /etc/nginx/conf.d/minio-your-domain.conf，nginx -t 验证通过后 reload。
#
# 公网入口采用子域 minio.your-domain.example.com（非路径前缀）。
# 原因：MinIO presigned URL 是 AWS SigV4 签名，签名串含 Host 头和 path，
#       路径前缀（/minio/...）会让验签失败。子域是唯一可行形态。
#       详见 docs/ops/minio-public-ingress.md 与
#       packages/server/src/domain/storage/minio.ts 里的 path-prefix guard。
#
# 前提（必须先满足，否则脚本会失败或行为异常）：
#   - DNS：minio.your-domain.example.com 的 A 记录已指向 YOUR_SERVER
#     （本脚本不创建 DNS；DNS 没生效时，最后一步 curl 探测会 WARN）
#   - 服务器上 dramaforge 的 MinIO 容器已起（docker compose ps 能看到 minio，
#     监听 127.0.0.1:9000）
#   - 服务器上已装 nginx 并在运行（systemctl status nginx）
#   - 本机 ~/.ssh/deploy_key 能免密登录 root@YOUR_SERVER
#
# 本脚本 **不做** 的事（属于 Task 6b，需用户在场）：
#   - 不跑 certbot（HTTPS 证书）。certbot 需要 DNS 已生效 + 80 端口对外
#     可达，是独立步骤；runbook 第 2 步单独写。
#   - 不改 dramaforge .env（MINIO_PUBLIC_BASE_URL 只在 cutover/re-cutover 时切）。
#   - 不 reload 任何与 MinIO 无关的服务。
#
# 用法：bash scripts/provision-nginx-minio.sh
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."   # 仓库根，使 scripts/nginx/... 相对路径可读

SERVER=root@YOUR_SERVER
SSH_KEY="$HOME/.ssh/deploy_key"
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SERVER")

LOCAL_CONF="scripts/nginx/minio-your-domain.conf"
REMOTE_CONF="/etc/nginx/conf.d/minio-your-domain.conf"

if [[ ! -f "$LOCAL_CONF" ]]; then
  echo "❌ 找不到本地 server_block：$LOCAL_CONF"
  echo "   请在仓库根目录执行：bash scripts/provision-nginx-minio.sh"
  exit 1
fi

if [[ ! -f "$SSH_KEY" ]]; then
  echo "❌ 找不到 SSH key：$SSH_KEY"
  echo "   部署 key 缺失，无法登录服务器。"
  exit 1
fi

echo "=== [1/4] 上传 server_block → ${REMOTE_CONF} ==="
# 用 scp 直传文件（比 heredoc 更稳：避免 shell 转义吃掉 nginx 变量 $host 等）
scp -i "$SSH_KEY" -o StrictHostKeyChecking=no \
    "$LOCAL_CONF" "${SERVER}:${REMOTE_CONF}"

echo "=== [2/4] nginx -t（验证语法；不通过则不 reload，保护现网）==="
# 关键：nginx -t 失败时 set -e 会让脚本在此中断，不会执行后续 reload。
#       这是 GC-5（服务器稳定性）的硬要求：绝不用坏配置 reload。
"${SSH[@]}" "nginx -t"

echo "=== [3/4] nginx -s reload（应用新配置）==="
"${SSH[@]}" "nginx -s reload"

echo "=== [4/4] 公网探测 http://minio.your-domain.example.com/ ==="
# DNS 可能尚未生效（6b 之前用户可能还没加 A 记录），失败只 WARN 不 abort。
# -I 只取 header；--max-time 5 避免 DNS 慢卡住脚本。
if curl -sI --max-time 5 http://minio.your-domain.example.com/ >/dev/null 2>&1; then
  echo "  -> 探测通过（DNS + nginx + MinIO 链路通）"
else
  echo "  ⚠️  WARN: http://minio.your-domain.example.com/ 探测失败。"
  echo "     常见原因：① DNS A 记录还没加 / 还没生效（Task 6b prereq）"
  echo "              ② 服务器 MinIO 容器没起"
  echo "              ③ 安全组没放行 :80"
  echo "     server_block 已部署 + reload 完成；待 DNS 生效后公网即通。"
fi

echo ""
echo "✅ provision 完成（仅 :80）。下一步见 docs/ops/minio-public-ingress.md："
echo "   ① certbot --nginx -d minio.your-domain.example.com --redirect  加 HTTPS"
echo "   ② re-cutover 时在 dramaforge .env 设 MINIO_PUBLIC_BASE_URL=https://minio.your-domain.example.com"
