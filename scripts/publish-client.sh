#!/usr/bin/env bash
# =============================================================================
# publish-client.sh — 发布 DramaForge 客户端新版本到生产（带 Ed25519 签名）
# =============================================================================
# 用法：
#   bash scripts/publish-client.sh <version> <私钥PEM路径> [--force]
#     <version>       如 0.0.1（必须与 packages/client/package.json 的 version 一致）
#     <私钥PEM路径>   gen-update-key.mjs 生成的 Ed25519 私钥（本地持有，离线保管）
#     --force         同时把 minVersion 提到 <version>，强制淘汰所有旧版（⑬ force_upgrade）
#
# 前提：
#   1. .exe 已打包：packages/client/release/DramaForge-<version>-x64.exe
#      （根目录: pnpm --filter @dramaforge/client package；记得带镜像 env：
#       ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/）
#   2. 已用 gen-update-key.mjs 生成密钥对，公钥已编译进客户端
#      （main/index.ts 的 UPDATE_SIGNING_PUBLIC_KEY）。
#   3. dramaforge 已 cutover（dramaforge-postgres 容器在跑）。
#   4. nginx 已加 /downloads/ location（一次性，见末尾"首次发布前"提示）。
#
# 效果：
#   - 对 .exe 算 Ed25519 签名 + sha256（防供应链投毒：服务器沦陷换 .exe 也
#     过不了客户端硬编码公钥的验签）。
#   - .exe 上传到服务器 /opt/dramaforge/client-releases/
#   - system_configs.CLIENT_VERSIONS_MANIFEST 更新（含 signature + sha256）
#   - 验签版客户端下次轮询拉到新版 → Ed25519 验签通过 → 提示重启
#   - --force 时 minVersion=<version> → 旧版 ⑬ 心跳 force_upgrade 锁死直到升级
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:?用法: $0 <version> <私钥PEM路径> [--force]}"
KEY_PATH="${2:?用法: $0 <version> <私钥PEM路径> [--force]}"
FORCE=""
shift 2 || true
for arg in "$@"; do
  if [ "$arg" = "--force" ]; then
    FORCE="--force"
  else
    echo "❌ 未知参数: $arg（只接受 --force）"; exit 1
  fi
done

EXE="packages/client/release/DramaForge-${VERSION}-x64.exe"
[ -f "$EXE" ] || {
  echo "❌ $EXE 不存在。先打包："
  echo "   ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \\"
  echo "   pnpm --filter @dramaforge/client package   (version=$VERSION)"
  exit 1
}
[ -f "$KEY_PATH" ] || { echo "❌ Ed25519 私钥不存在: $KEY_PATH（用 gen-update-key.mjs 生成）"; exit 1; }

SERVER=root@YOUR_SERVER
SSH_KEY="${SSH_KEY:-$HOME/.ssh/deploy_key}"
[ -f "$SSH_KEY" ] || { echo "❌ SSH key 不存在: $SSH_KEY"; exit 1; }
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SERVER")
SCP=(scp -i "$SSH_KEY" -o StrictHostKeyChecking=no)
REMOTE_DIR=/opt/dramaforge/client-releases
URL="https://your-domain.example.com/downloads/DramaForge-${VERSION}-x64.exe"

echo "=== 1/5 对 .exe 算 Ed25519 签名 + sha256（防供应链投毒） ==="
SIGN_JSON=$(node "$(dirname "$0")/sign-client.mjs" "$EXE" "$KEY_PATH") || { echo "❌ 签名失败"; exit 1; }
SIGNATURE=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).signature)' "$SIGN_JSON")
SHA256=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sha256)' "$SIGN_JSON")
[ -n "$SIGNATURE" ] && [ -n "$SHA256" ] || { echo "❌ 签名输出不完整，拒绝发布（fail-closed）"; exit 1; }
echo "    signature: ${SIGNATURE:0:32}...  sha256: ${SHA256:0:16}..."

echo "=== 2/5 上传 .exe → $SERVER:$REMOTE_DIR/ ==="
"${SSH[@]}" "mkdir -p $REMOTE_DIR"
"${SCP[@]}" "$EXE" "$SERVER:$REMOTE_DIR/"
"${SSH[@]}" "cd $REMOTE_DIR && ln -sfn DramaForge-${VERSION}-x64.exe DramaForge-latest-x64.exe"
echo "    latest symlink -> DramaForge-latest-x64.exe (https://your-domain.example.com/downloads)"
echo "    已上传: $(basename "$EXE") ($(( $(stat -c%s "$EXE") / 1024 / 1024 )) MB)"

echo "=== 3/5 读服务器 .env 拿 PG 凭据 ==="
PG_VARS=$("${SSH[@]}" "set -a; . /opt/dramaforge/.env 2>/dev/null; echo PGU=\${POSTGRES_USER:-postgres}; echo PGD=\${POSTGRES_DB:-dramaforge}")
PG_USER=$(echo "$PG_VARS" | sed -n 's/^PGU=//p')
PG_DB=$(echo "$PG_VARS" | sed -n 's/^PGD=//p')
echo "    POSTGRES_USER=$PG_USER  POSTGRES_DB=$PG_DB"

echo "=== 4/5 更新 system_configs.CLIENT_VERSIONS_MANIFEST（含签名） ==="
if [ "$FORCE" == "--force" ]; then
  MIN_VERSION="$VERSION"
  echo "    --force: minVersion=$VERSION（旧版将被锁死直到升级）"
else
  MIN_VERSION="0.0.0"
  echo "    minVersion=0.0.0（不强制淘汰，软提示更新）"
fi

# manifest JSON 形状见 packages/web/lib/versions.ts：VersionsManifest
#   { minVersion, latestVersion, downloadUrls:{win,mac,linux}, signature, sha256 }
MANIFEST="{\"minVersion\":\"$MIN_VERSION\",\"latestVersion\":\"$VERSION\",\"downloadUrls\":{\"win\":\"$URL\",\"mac\":\"\",\"linux\":\"\"},\"signature\":\"$SIGNATURE\",\"sha256\":\"$SHA256\"}"

# 用 PG dollar-quoting（$JSON$...$JSON$）避免 JSON 双引号转义。
# heredoc <<SQL（未加引号）让 shell 展开 $MANIFEST（本地构造的 JSON），
# 而 \$JSON\$ 转义后字面量 $JSON$ 作为 dollar-quote 标签。
"${SSH[@]}" "docker exec -i dramaforge-postgres psql -U '$PG_USER' -d '$PG_DB'" <<SQL
INSERT INTO system_configs (id, key, value, "updatedAt")
VALUES ('client-versions', 'CLIENT_VERSIONS_MANIFEST', \$JSON\$$MANIFEST\$JSON\$::text, NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = NOW();
SQL
echo "    manifest 已更新: latestVersion=$VERSION  minVersion=$MIN_VERSION  signature已附"

echo "=== 5/5 验证 .exe 可下载（nginx /downloads/） ==="
HTTP=$("${SSH[@]}" "curl -s -o /dev/null -w '%{http_code}' -I $URL" 2>/dev/null || echo "000")
if [ "$HTTP" == "200" ]; then
  echo "    ✅ $URL → 200 OK"
else
  echo "    ⚠️  $URL → HTTP $HTTP"
  echo "    若非 200：nginx 可能没加 /downloads/ location。"
  echo "    在 dramaforge.conf 的 server 块加这段后 nginx -t && nginx -s reload："
  echo "      location /downloads/ { alias $REMOTE_DIR/; autoindex off; }"
fi

echo ""
echo "✅ 发布完成: $URL"
echo "   验签版客户端下次轮询拉到新版 → Ed25519 验签通过 → 提示重启。"
# 注意：末尾不能用裸 `[ "$FORCE" == "--force" ] && echo ...` —— 非 --force 时
# 该测试返回 1，在 set -e 下会让脚本以 exit 1 收尾，明明发布成功却报失败。
# `|| true` 兜底，保证成功路径始终 exit 0。
[ "$FORCE" == "--force" ] && echo "   minVersion=$VERSION → 旧版 ⑬ 心跳 force_upgrade 锁死直到升级。" || true
true
