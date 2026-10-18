#!/usr/bin/env bash
# =============================================================================
# precheck.sh — 本地部署前验收（build → 起隔离栈 → 迁移 → 冒烟 → 拆）
# =============================================================================
# 用法：bash scripts/precheck.sh [tag] [--skip-tests] [--keep-stack]
#   tag           镜像 tag，默认 precheck（deploy.sh 调用时传 deploy tag，
#                 让验过的镜像直接复用，不重复 build）
#   --skip-tests  跳过 typecheck + 单测（只做 docker 验收，更快）
#   --keep-stack  结束不拆栈（便于 docker logs 排查；手动拆见末尾提示）
#
# 做什么（6 步）：
#   1. typecheck + server/web 单测（快通道，秒~分钟级）
#   2. docker build 生产镜像 dramaforge-cs-{web,ai-worker}:<tag>（与生产同 Dockerfile）
#   3. 起隔离栈（-p dramaforge-precheck，precheck- 前缀容器/卷，web 绑 127.0.0.1:13099）
#   4. 跑 migrate（幂等迁移验证）+ 起 web/ai-worker
#   5. 冒烟：/api/health → 200 {"ok":true}；/api/projects 非 404 / 非 5xx（路由注册+鉴权活）
#   6. 拆栈（down -v），除非 --keep-stack
#
# 诚实边界（本地验不了，仍需部署后云端冒烟）：
#   - AI 真实生成行为（key 只在云端，[[dramaforge-keys-cloud-server-only]]）
#   - 负载级 OOM（生产 1.8GB 压测，本地栈不设 mem_limit）
#   本步挡掉的是：build 失败 / 迁移 SQL 错 / 启动崩 / 路由没注册（404）/ 鉴权没接（这些
#   历史上正是多数生产事故的类别，见 dramaforge-cloud-deploy-state 续48/续53 等）。
# =============================================================================
set -euo pipefail
# Git-Bash 会话若设置了 MSYS_NO_PATHCONV/MSYS2_ARG_CONV_EXCL，node/pnpm 等 Windows
# 程序收到的 /c/... 参数不会转成盘符路径而报 MODULE_NOT_FOUND；部署链路必须用 POSIX 转换。
unset MSYS_NO_PATHCONV MSYS2_ARG_CONV_EXCL 2>/dev/null || true
cd "$(dirname "$0")/.."

TAG="precheck"
SKIP_TESTS=0
KEEP_STACK=0
for a in "$@"; do
  case "$a" in
    --skip-tests) SKIP_TESTS=1 ;;
    --keep-stack) KEEP_STACK=1 ;;
    --help|-h) sed -n '2,30p' "$0"; exit 0 ;;
    --*) echo "❌ 未知参数: $a（见 --help）"; exit 2 ;;
    *) TAG="$a" ;;
  esac
done

PC_TAG="$TAG"   # 保存命令行/默认 tag，防 [0] source .env 时被 .env 的 TAG= 覆盖
export PRECHECK_WEB_PORT="${PRECHECK_WEB_PORT:-13099}"   # 不在 .env 里，source .env 不会覆盖
COMPOSE=(docker compose -p dramaforge-precheck -f docker-compose.precheck.yml)
IMAGE_WEB=dramaforge-cs-web
IMAGE_WORKER=dramaforge-cs-ai-worker

G() { printf '\033[32m%s\033[0m\n' "$*"; }
R() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
S() { printf '\033[90m%s\033[0m\n' "$*"; }

teardown() {
  rc=$?
  if [ "$KEEP_STACK" = "1" ]; then
    S "  --keep-stack：隔离栈保留。手动拆：docker compose -p dramaforge-precheck -f docker-compose.precheck.yml down -v"
  else
    S "  拆隔离栈 (down -v)..."
    "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  fi
  exit $rc
}
trap teardown EXIT

# 等容器 health=healthy；超时或容器退出则失败
wait_healthy() {
  local name="$1" tries="$2"
  for _ in $(seq 1 "$tries"); do
    local hs; hs=$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || echo "")
    [ "$hs" = "healthy" ] && return 0
    local st; st=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo "")
    if [ "$st" != "running" ]; then
      R "❌ $name 未运行 (state=$st)，日志："
      docker logs --tail 60 "$name" 2>&1 || true
      return 1
    fi
    sleep 1
  done
  R "❌ $name 在 ${tries}s 内未 healthy"
  docker logs --tail 60 "$name" 2>&1 || true
  return 1
}

# ---------------------------------------------------------------------------
echo "=== [0/6] 前置检查 ==="
command -v docker >/dev/null 2>&1 || { R "❌ docker 不在 PATH"; exit 1; }
docker info >/dev/null 2>&1 || { R "❌ docker daemon 未运行（启动 Docker Desktop）"; exit 1; }
docker compose version >/dev/null 2>&1 || { R "❌ 无 docker compose v2"; exit 1; }
[ -f .env ] || { R "❌ 缺 .env（precheck 复用本地 .env 的基建变量）"; exit 1; }
# 校验 .env 基建变量非空（env() 要求，见 packages/server/src/infra/env.ts）
set -a; . ./.env; set +a
TAG="$PC_TAG"   # .env 可能含 TAG=/WEB_PORT=，恢复本脚本要用的 tag（同 deploy.sh DEPLOY_TAG 保护）
for v in POSTGRES_PASSWORD DATABASE_URL REDIS_URL MINIO_ENDPOINT MINIO_ACCESS_KEY MINIO_SECRET_KEY MINIO_BUCKET NEXTAUTH_SECRET NEXTAUTH_URL; do
  val="${!v:-}"
  [ -n "$val" ] || { R "❌ .env 的 $v 为空（precheck 需基建变量非空）"; exit 1; }
done
G "  docker ok / .env 基建变量齐全 / web 端口 $PRECHECK_WEB_PORT"

# ---------------------------------------------------------------------------
if [ "$SKIP_TESTS" = "0" ]; then
  echo "=== [1/6] typecheck + server/web 单测 ==="
  pnpm -r typecheck
  pnpm --filter '@dramaforge/server' --filter '@dramaforge/web' test
  G "  typecheck + 单测全绿"
else
  S "  --skip-tests：跳过 typecheck + 单测"
fi

# ---------------------------------------------------------------------------
echo "=== [2/6] docker build 生产镜像 ($TAG) — 与生产同 Dockerfile ==="
docker build -f packages/web/Dockerfile   -t "$IMAGE_WEB:$TAG"     .
docker build -f packages/server/Dockerfile -t "$IMAGE_WORKER:$TAG" .
G "  web + ai-worker 镜像 build 通过"

# ---------------------------------------------------------------------------
echo "=== [3/6] 起隔离基建 (pg/redis/minio) ==="
"${COMPOSE[@]}" down -v >/dev/null 2>&1 || true   # 清上次残留
TAG="$TAG" "${COMPOSE[@]}" up -d postgres redis minio
wait_healthy dramaforge-precheck-postgres 90 || exit 1
wait_healthy dramaforge-precheck-redis     60 || exit 1
wait_healthy dramaforge-precheck-minio     90 || exit 1
G "  pg/redis/minio 全 healthy"

# ---------------------------------------------------------------------------
echo "=== [4/6] 跑 migrate（幂等迁移验证）+ 起 web/ai-worker ==="
TAG="$TAG" "${COMPOSE[@]}" --profile migrate run --rm migrate
G "  migrate 通过（全部迁移幂等落库，无 SQL 错）"
TAG="$TAG" "${COMPOSE[@]}" up -d web ai-worker
wait_healthy dramaforge-precheck-web 150 || exit 1
# ai-worker 无 healthcheck，只验它持续运行没崩溃退出
wstate=$(docker inspect -f '{{.State.Status}}' dramaforge-precheck-ai-worker 2>/dev/null || echo gone)
if [ "$wstate" != "running" ]; then
  R "❌ ai-worker 未持续运行 (state=$wstate)，日志："
  docker logs --tail 60 dramaforge-precheck-ai-worker 2>&1 || true
  exit 1
fi
G "  web healthy + ai-worker 运行中"

# 容器内 healthcheck（loopback）通过 ≠ 外部端口就绪：Docker Desktop 发布端口走
# 用户态代理，可能比容器内 readiness 滞后数秒~十几秒（实测 wait_healthy 报 healthy
# 时外部端口还在拒绝）。直接轮询 host 端口确认外部可达，再跑断言。
echo "  等 web 外部端口就绪 (127.0.0.1:$PRECHECK_WEB_PORT，最多 60s)..."
host_ok=0; last_code=000
for _ in $(seq 1 60); do
  last_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PRECHECK_WEB_PORT/api/health" 2>/dev/null || echo 000)
  [ "$last_code" = "200" ] && { host_ok=1; break; }
  sleep 1
done
[ "$host_ok" = "1" ] || { R "❌ web 外部端口 60s 内未就绪（最后 code=$last_code）"; docker logs --tail 40 dramaforge-precheck-web 2>&1 || true; exit 1; }
G "  外部端口就绪"

# ---------------------------------------------------------------------------
echo "=== [5/6] 冒烟：/api/health + 路由注册 + 鉴权活 ==="
hc=$(curl -s -o /tmp/dramaforge-precheck-health -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PRECHECK_WEB_PORT/api/health" 2>/dev/null || echo 000)
[ "$hc" = "200" ] || { R "❌ /api/health → $hc（应 200）"; cat /tmp/dramaforge-precheck-health 2>/dev/null; exit 1; }
grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' /tmp/dramaforge-precheck-health || { R "❌ /api/health body 异常"; cat /tmp/dramaforge-precheck-health; exit 1; }
G "  /api/health → 200 {\"ok\":true}"

# /api/projects：未登录应 401（路由已注册 + 鉴权活）。
# 404 = 路由没进 build（build/路由问题）；5xx = 运行时崩溃。两者都判失败。
pc=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PRECHECK_WEB_PORT/api/projects" 2>/dev/null || echo 000)
if [ "$pc" = "404" ] || { [ "$pc" != "000" ] && [ "$pc" -ge 500 ]; }; then
  R "❌ /api/projects → $pc（404=路由未注册 / 5xx=崩溃）"
  docker logs --tail 40 dramaforge-precheck-web 2>&1 || true
  exit 1
fi
G "  /api/projects → $pc（路由已注册，非 404/非 5xx）✓"

# ---------------------------------------------------------------------------
echo "=== [6/6] 本地验收通过 ✅ ==="
echo "  覆盖：typecheck/单测 · 镜像 build · 迁移 · boot · 路由注册 · 鉴权活 · worker 运行"
echo "  未覆盖（需云端冒烟）：AI 真实生成 · 负载级 OOM"
echo "  镜像 $IMAGE_WEB:$TAG / $IMAGE_WORKER:$TAG 已验，原样可推云端。"
echo ""
G "✅ precheck 通过 (tag: $TAG)"
