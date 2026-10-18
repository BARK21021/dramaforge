#!/usr/bin/env bash
# ============================================================
# migrate-app1-data.sh — app1(video_stylization) → dramaforge(dramaforge) 数据迁移
# ============================================================
#
# 前提：dramaforge 目标库已跑过 migrate（schema 就位，render_jobs 空表存在）。
# app1 与 dramaforge 的 14 张业务表 schema 已列级核对完全一致（dramaforge 0001-init.sql
# 从 app1 migrate.ts 移植）。故这 14 表可直接 data-only dump/restore。
# app1 payment_orders 是驼峰列、dramaforge 是 snake_case，明确不迁；restore 会原子保留
# dramaforge 已有 payment_orders。管理员 API Key 池与 provider_files 只属于 C/S 云端，迁移时
# 必须保护；app1 的用户级 api_configs 不再导入。render_jobs / _migrations 同样不动。
#
# 用法：
#   bash scripts/migrate-app1-data.sh dump            # SSH 服务器 dump app1 数据 → scripts/app1-data.sql
#   bash scripts/migrate-app1-data.sh restore local   # 还原到本地 dramaforge-postgres（dry-run）
#   bash scripts/migrate-app1-data.sh restore prod    # 还原到生产 dramaforge-postgres（cutover 时用）
#
# ⚠️ scripts/app1-data.sql 含真实用户密码哈希 + API key，已 .gitignore，绝不提交。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."   # 仓库根

SERVER="${SERVER:-root@YOUR_SERVER}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/deploy_key}"
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SERVER")

DUMP_FILE="${DUMP_FILE:-scripts/app1-data.sql}"

# app1 源（生产 sf-postgres 容器）
APP1_CONTAINER="${APP1_CONTAINER:-sf-postgres}"
APP1_USER="${APP1_USER:-dramaforge}"
APP1_DB="${APP1_DB:-video_stylization}"

# dramaforge 目标
DRAMAFORGE_CONTAINER="${DRAMAFORGE_CONTAINER:-dramaforge-postgres}"
DRAMAFORGE_USER="${DRAMAFORGE_USER:-postgres}"       # dramaforge compose POSTGRES_USER 默认 postgres（superuser，--disable-triggers 需要）
DRAMAFORGE_DB="${DRAMAFORGE_DB:-dramaforge}"

# 14 张 schema 完全兼容的业务表。payment_orders 在 dramaforge 中改为 snake_case，
# render_jobs / _migrations 仅属于 dramaforge，因此三者都不能从 app1 dump 导入。
TABLES=(
  users user_preferences seedance_presets projects storyboards assets
  tasks task_events billing_ledger system_configs episodes shots materials
)

# 远端命令只拼接上面的静态表名；--strict-names 保证任何漏表都会让 dump 失败，
# 不会悄悄产出一个不完整快照。
TABLES_CSV=""
TABLE_SELECTOR_ARGS=""
for table in "${TABLES[@]}"; do
  [[ -n "$TABLES_CSV" ]] && TABLES_CSV+=","
  TABLES_CSV+="public.$table"
  TABLE_SELECTOR_ARGS+=" --table=public.$table"
done

# 生成一次 restore 的完整 SQL 流。调用方必须用 psql --single-transaction：
#   1) 临时保存 dramaforge 自己产生的 payment_orders 与 provider_files；管理员 Key 表不清空；
#   2) 显式 TRUNCATE 全部 FK 关联表（不用 CASCADE，防止未来新增表被静默清空）；
#   3) 导入 app1 的 14 张表；
#   4) 兼容旧 dump 的 11 位手机号，再恢复 +86 CHECK；
#   5) 恢复平台 Key、文件归属映射与 payment_orders。任一步失败则整次 restore 回滚。
emit_restore_sql() {
  cat <<'SQL'
CREATE TEMP TABLE dramaforge_payment_orders_backup
ON COMMIT DROP
AS TABLE public.payment_orders;

-- provider_files 会随业务表一起重建，因此先备份并在导入后恢复。
-- 一并保存原 Key 内容，恢复时只把映射接回身份未变化的管理员配置，避免 ID 碰撞误绑。
CREATE TEMP TABLE dramaforge_provider_files_backup
ON COMMIT DROP
AS
SELECT
  pf.file_id,
  pf.provider,
  pf.api_config_id,
  pf.uploaded_at,
  ac."apiKey" AS api_config_key
FROM public.provider_files AS pf
LEFT JOIN public.api_configs AS ac ON ac.id = pf.api_config_id;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_phone_format_check;
SQL

  printf 'TRUNCATE public.payment_orders,public.provider_files,%s;\n' "$TABLES_CSV"
  cat "$DUMP_FILE"
  printf '\n'

  cat <<'SQL'
-- app1 历史数据可能仍是 11 位国内手机号；在重新启用 CHECK 前统一为 +86。
UPDATE public.users
SET phone = '+86' || phone
WHERE phone IS NOT NULL
  AND phone ~ '^1[3-9][0-9]{9}$';

UPDATE public.users
SET phone = '+86' || email,
    email = NULL
WHERE phone IS NULL
  AND email IS NOT NULL
  AND email ~ '^1[3-9][0-9]{9}$';

ALTER TABLE public.users
  ADD CONSTRAINT users_phone_format_check
  CHECK (phone IS NULL OR phone LIKE '+86%');

-- 只有配置 ID 和 API Key 都与备份时一致才恢复粘性归属；已消失或发生 ID 碰撞的
-- 用户级 Key 映射安全降级为 NULL，运行时会重新进入平台 Key 轮询。
INSERT INTO public.provider_files (file_id, provider, api_config_id, uploaded_at)
SELECT
  backup.file_id,
  backup.provider,
  CASE
    WHEN current_config.id IS NOT NULL
      AND current_config."apiKey" IS NOT DISTINCT FROM backup.api_config_key
    THEN backup.api_config_id
    ELSE NULL
  END,
  backup.uploaded_at
FROM pg_temp.dramaforge_provider_files_backup AS backup
LEFT JOIN public.api_configs AS current_config
  ON current_config.id = backup.api_config_id;

INSERT INTO public.payment_orders (
  id, out_trade_no, user_id, amount_yuan, credits, status, trade_no,
  pay_url, paid_at, credited_at, ledger_id, metadata, created_at, updated_at
)
SELECT
  id, out_trade_no, user_id, amount_yuan, credits, status, trade_no,
  pay_url, paid_at, credited_at, ledger_id, metadata, created_at, updated_at
FROM pg_temp.dramaforge_payment_orders_backup;
SQL
}

case "${1:-}" in
  dump)
    echo "=== dump app1 data → $DUMP_FILE ==="
    # --data-only: 只要数据（dramaforge 已有 schema）
    # --disable-triggers: SET session_replication_role=replica，关 FK 检查（需 superuser）
    # --no-owner / --no-privileges: 不带 app1 owner/权限
    # --column-inserts: 显式 INSERT（可读、出错好定位；450 行无所谓慢）
    # --table: 只导出上面的 14 张兼容表，明确排除 camelCase payment_orders。
    dump_tmp="${DUMP_FILE}.tmp.$$"
    trap 'rm -f "$dump_tmp"' EXIT
    "${SSH[@]}" "docker exec $APP1_CONTAINER pg_dump --data-only --disable-triggers --no-owner --no-privileges --column-inserts --strict-names$TABLE_SELECTOR_ARGS -U $APP1_USER $APP1_DB" > "$dump_tmp"
    mv -f -- "$dump_tmp" "$DUMP_FILE"
    trap - EXIT
    echo "  → $(wc -l < "$DUMP_FILE") lines → $DUMP_FILE"
    echo "  ⚠️ 含敏感数据（密码哈希/API key），勿提交"
    ;;

  restore)
    TARGET="${2:-}"
    if [[ ! -f "$DUMP_FILE" ]]; then echo "❌ $DUMP_FILE 不存在，先跑: bash scripts/migrate-app1-data.sh dump"; exit 1; fi
    case "$TARGET" in
      local|prod) ;;
      *) echo "用法: $0 restore local|prod"; exit 1 ;;
    esac
    echo "=== restore $DUMP_FILE → $TARGET ($DRAMAFORGE_CONTAINER/$DRAMAFORGE_DB) ==="

    # 跑 psql 的封装：local 直连 docker，prod 走 ssh
    run_psql_local()  { docker exec -i "$DRAMAFORGE_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DRAMAFORGE_USER" -d "$DRAMAFORGE_DB" "$@"; }
    run_psql_prod() {
      # 每个 arg 单引号包好：ssh 把命令字符串发到远端后，远端 bash 会重新 word-split。
      # -c 的 SQL 含空格（如 "TRUNCATE a,b CASCADE"），必须作为单个 arg 传给 psql，
      # 否则 -c 只拿到第一个词（"TRUNCATE"），其余变 positional arg 被 ignored →
      # syntax error（曾导致 cutover [7] restore 失败）。local 直连用 "$@" 无此问题。
      local args=()
      local a
      for a in "$@"; do args+=("'$a'"); done
      "${SSH[@]}" "docker exec -i $DRAMAFORGE_CONTAINER psql -v ON_ERROR_STOP=1 -U $DRAMAFORGE_USER -d $DRAMAFORGE_DB ${args[*]}"
    }

    # 单个事务完成目标专属数据备份 → 清表 → 导入 → 规范化 → 恢复，失败整体回滚。
    # dump 内的 --disable-triggers 语句继续负责导入期间的 FK；CHECK 由 SQL 流显式处理。
    echo "  → atomic restore 14 tables (preserve platform keys/provider files/orders)..."
    if [[ "$TARGET" == "prod" ]]; then
      emit_restore_sql | "${SSH[@]}" "docker exec -i $DRAMAFORGE_CONTAINER psql -X --single-transaction -v ON_ERROR_STOP=1 -U $DRAMAFORGE_USER -d $DRAMAFORGE_DB"
    else
      emit_restore_sql | docker exec -i "$DRAMAFORGE_CONTAINER" psql -X --single-transaction -v ON_ERROR_STOP=1 -U "$DRAMAFORGE_USER" -d "$DRAMAFORGE_DB"
    fi

    # 校验行数（pg_stat_user_tables 近似值，n_live_tup 可能略滞后；必要时 VACUUM）
    echo "✅ restore 完成。行数校验："
    if [[ "$TARGET" == "prod" ]]; then
      run_psql_prod -c "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC" 2>/dev/null || true
    else
      run_psql_local -c "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC" 2>/dev/null || true
    fi
    ;;

  *)
    echo "用法: bash scripts/migrate-app1-data.sh dump | restore local|prod"
    exit 1
    ;;
esac
