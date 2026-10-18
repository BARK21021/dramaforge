#!/usr/bin/env bash
# =============================================================================
# diagnose-user.sh — dramaforge 单用户生产状态诊断
# =============================================================================
# 口语「4928」「4945」= 用户手机号末四位（users.phone 存 +8613... 国际格式，
# LIKE '%末四位' 命中）。脚本先 phone→UUID 再拉该用户全量状态。
#
# 检查项（对齐 docs/known-issues/chain-fakedeath.md 的 live gotcha）：
#   ① 用户解析    ② 非终态 render_jobs（卡死权威清单 + claim 硬上限）
#   ③ CHAIN_COMPILE 近况（chronic 用户高发）  ④ shots 卡 GENERATING（裸SQL绕级联的已知坑）
#   ⑤ 计费余额+流水  ⑥ tasks 状态分布
#
# 只 docker exec，绝不直连网络 pg（被安全分类器拦）。凭据从容器 env 现取。
#
# 用法：
#   本地一键：  ssh -i "KEY" root@YOUR_SERVER 'bash -s 4928' < scripts/diagnose-user.sh
#   服务器上：  bash scripts/diagnose-user.sh 4928
# =============================================================================
set -uo pipefail

SUFFIX="${1:-4928}"
PG_CONTAINER="dramaforge-postgres"
PGUSER="$(docker exec "$PG_CONTAINER" printenv POSTGRES_USER 2>/dev/null || echo postgres)"
PGDB="$(docker exec "$PG_CONTAINER" printenv POSTGRES_DB 2>/dev/null || echo dramaforge)"
psql() { docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" "$@"; }

# 该用户 UUID（多处复用，预先取到 shell 变量；拿不到就早退）
UIDX="$(psql -tA -c "SELECT id FROM users WHERE phone LIKE '%${SUFFIX}' ORDER BY \"createdAt\" DESC LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"

echo "================================================================"
echo " dramaforge 用户诊断   phone suffix=${SUFFIX}   pg=${PGUSER}@${PGDB}"
if [ -z "$UIDX" ]; then
  echo " ⚠ 未命中 users.phone LIKE '%${SUFFIX}' —— 终止（列候选见下）"
  echo "----------------------------------------------------------------"
  psql -c "SELECT id, phone, left(coalesce(email,'-'),24) AS email FROM users WHERE phone IS NOT NULL ORDER BY \"createdAt\" DESC LIMIT 30;"
  exit 0
fi
echo " resolved uid=${UIDX}"
echo "================================================================"
echo

# ① 用户基本信息
echo "## ① 用户 (id / phone / credits / role / lastLogin)"
psql -c "
SELECT id, phone, credits, role, left(coalesce(name,'-'),16) AS name,
       left(coalesce(email,'-'),24) AS email,
       \"createdAt\"::date AS joined, \"lastLoginAt\" AS last_login
FROM users WHERE id = '${UIDX}';
"
echo

# ② 非终态 render_jobs（卡死权威清单）+ claim 硬上限（LONG_VIDEO_REWRITE 12h / 其余 4h）
echo "## ② 非终态 render_jobs (PENDING/CLAIMED/RUNNING) —— cap=PAST_CAP 即过硬上限"
psql -c "
SELECT id, type, status,
       CASE WHEN claimed_at IS NULL THEN NULL
            ELSE extract(epoch from now()-claimed_at)::int END AS claim_s,
       CASE WHEN heartbeat_at IS NULL THEN NULL
            ELSE extract(epoch from now()-heartbeat_at)::int END AS hb_s,
       (result IS NOT NULL) AS has_result,
       CASE WHEN ( (type='LONG_VIDEO_REWRITE' AND claimed_at < now()-interval '12 hours')
                OR (type<>'LONG_VIDEO_REWRITE' AND claimed_at < now()-interval '4 hours'))
            THEN 'PAST_CAP' ELSE 'ok' END AS cap,
       left(coalesce(error,''),70) AS err
FROM render_jobs
WHERE user_id = '${UIDX}' AND status IN ('PENDING','CLAIMED','RUNNING')
ORDER BY created_at DESC;
"
echo

# ③ CHAIN_COMPILE 近 15 条（chronic 用户高发，看是否又踩假死/0产出）
echo "## ③ CHAIN_COMPILE 近 15 条（chronic 用户高发）"
psql -c "
SELECT created_at::date AS day, status,
       CASE WHEN claimed_at IS NULL THEN NULL
            ELSE extract(epoch from now()-claimed_at)::int/60 END AS claim_min,
       (result IS NOT NULL) AS has_result,
       left(coalesce(error,''),70) AS err
FROM render_jobs
WHERE user_id = '${UIDX}' AND type='CHAIN_COMPILE'
ORDER BY created_at DESC LIMIT 15;
"
echo

# ④ shots 卡 GENERATING（运维裸 SQL 绕 G3-1 级联的已知坑，4928 曾中招）
echo "## ④ shots 卡 GENERATING（裸SQL绕级联已知坑；正常最多滞后 60s sweep 兜底）"
psql -c "
SELECT s.id, left(coalesce(p.title,'-'),20) AS project, s.\"episodeId\" AS ep,
       s.\"shotIndex\" AS idx, s.\"videoStatus\"
FROM shots s JOIN projects p ON p.id = s.\"projectId\"
WHERE s.\"videoStatus\" = 'GENERATING' AND p.\"userId\" = '${UIDX}'
ORDER BY s.\"createdAt\" DESC;
"
echo

# ⑤ 计费：余额 + 近 15 笔流水（PENDING_DEBIT 堆积 = 欠费漏损信号）
echo "## ⑤ 计费：近 15 笔流水（PENDING_DEBIT 堆积=漏损信号）"
psql -c "
SELECT type, credits, \"createdAt\"::date AS day, left(coalesce(description,''),40) AS descr
FROM billing_ledger WHERE \"userId\" = '${UIDX}'
ORDER BY \"createdAt\" DESC LIMIT 15;
"
echo

# ⑥ tasks 状态分布
echo "## ⑥ tasks 状态分布"
psql -c "
SELECT status, type, count(*) AS n
FROM tasks WHERE \"userId\" = '${UIDX}'
GROUP BY status, type ORDER BY status, type;
"
echo

echo "================================================================"
echo " 判读："
echo "  • ② 有 PAST_CAP 且 hb_s<120 = 典型假死（心跳续租骗过 lease，硬上限已到）。"
echo "  • ④ 非空 = 镜头永久卡 GENERATING（sweep 60s 兜底没生效或被绕过）。"
echo "  • 止血走 admin route POST /api/admin/render-jobs/[id]/force-fail，别裸 UPDATE。"
echo "  • 详见 docs/known-issues/chain-fakedeath.md。"
echo "================================================================"
