#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$SCRIPT_DIR/.." && pwd)/migrate-app1-data.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_contains() {
  local file="$1"
  local needle="$2"
  grep -Fq -- "$needle" "$file" || fail "$file missing: $needle"
}

assert_file_not_contains() {
  local file="$1"
  local needle="$2"
  if grep -Fq -- "$needle" "$file"; then
    fail "$file unexpectedly contains: $needle"
  fi
}

# The executable test must never touch the real ignored dump. Requiring an
# environment-overridable path is itself part of the script's testability and
# operational safety contract.
assert_file_contains "$SCRIPT" 'DUMP_FILE="${DUMP_FILE:-scripts/app1-data.sql}"'

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

dump_file="$tmp_dir/app1-data.sql"
ssh_args_file="$tmp_dir/ssh-args.txt"
docker_args_file="$tmp_dir/docker-args.txt"
restore_sql_file="$tmp_dir/restore.sql"

export MIGRATE_TEST_SSH_ARGS="$ssh_args_file"
export MIGRATE_TEST_DOCKER_ARGS="$docker_args_file"
export MIGRATE_TEST_RESTORE_SQL="$restore_sql_file"

ssh() {
  printf '%s\n' "$*" > "$MIGRATE_TEST_SSH_ARGS"
  cat <<'SQL'
-- fake app1 data dump
INSERT INTO public.users (id, email, phone) VALUES ('u-1', NULL, '13800138000');
SELECT pg_catalog.set_config('search_path', '', false);
SQL
}
export -f ssh

docker() {
  if [[ "$*" == *"--single-transaction"* ]]; then
    printf '%s\n' "$*" > "$MIGRATE_TEST_DOCKER_ARGS"
    cat > "$MIGRATE_TEST_RESTORE_SQL"
    if [[ "${MIGRATE_TEST_DOCKER_FAIL:-0}" == "1" ]]; then
      return 23
    fi
  fi
}
export -f docker

# Dump must select only the 14 compatible source tables. In particular, the
# camelCase app1 payment_orders table must never enter the snake_case dramaforge dump.
DUMP_FILE="$dump_file" bash "$SCRIPT" dump >/dev/null

tables=(
  users user_preferences api_configs seedance_presets projects storyboards assets
  tasks task_events billing_ledger system_configs episodes shots materials
)
for table in "${tables[@]}"; do
  assert_file_contains "$ssh_args_file" "--table=public.$table"
done
assert_file_not_contains "$ssh_args_file" "--table=public.payment_orders"

selector_count="$({ grep -oE -- '--table=public\.[a-z_]+' "$ssh_args_file" || true; } | sort -u | wc -l | tr -d ' ')"
[[ "$selector_count" == "${#tables[@]}" ]] \
  || fail "expected ${#tables[@]} explicit table selectors, got $selector_count"

# Restore is inspected through a fake docker/psql seam: it must be one
# transaction, preserve target-only orders/platform keys/provider mappings, and
# normalize old phones before reinstating the +86 CHECK constraint.
DUMP_FILE="$dump_file" bash "$SCRIPT" restore local >/dev/null

assert_file_contains "$docker_args_file" "--single-transaction"
assert_file_contains "$docker_args_file" "ON_ERROR_STOP=1"

assert_file_contains "$restore_sql_file" "CREATE TEMP TABLE dramaforge_payment_orders_backup"
assert_file_contains "$restore_sql_file" "CREATE TEMP TABLE dramaforge_platform_api_configs_backup"
assert_file_contains "$restore_sql_file" "WHERE \"userId\" IS NULL"
assert_file_contains "$restore_sql_file" "CREATE TEMP TABLE dramaforge_provider_files_backup"
assert_file_contains "$restore_sql_file" "TRUNCATE public.payment_orders,public.provider_files,"
assert_file_not_contains "$restore_sql_file" "CASCADE"
assert_file_contains "$restore_sql_file" "ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_phone_format_check"
assert_file_contains "$restore_sql_file" "SET phone = '+86' || phone"
assert_file_contains "$restore_sql_file" "ADD CONSTRAINT users_phone_format_check"
assert_file_contains "$restore_sql_file" "INSERT INTO public.api_configs"
assert_file_contains "$restore_sql_file" "FROM pg_temp.dramaforge_platform_api_configs_backup"
assert_file_contains "$restore_sql_file" "INSERT INTO public.provider_files"
assert_file_contains "$restore_sql_file" "FROM pg_temp.dramaforge_provider_files_backup AS backup"
assert_file_contains "$restore_sql_file" "current_config.\"apiKey\" IS NOT DISTINCT FROM backup.api_config_key"
assert_file_contains "$restore_sql_file" "INSERT INTO public.payment_orders"
assert_file_contains "$restore_sql_file" "FROM pg_temp.dramaforge_payment_orders_backup"
assert_file_contains "$restore_sql_file" "-- fake app1 data dump"

line_of() {
  grep -nF -- "$1" "$restore_sql_file" | head -1 | cut -d: -f1
}

backup_line="$(line_of 'CREATE TEMP TABLE dramaforge_payment_orders_backup')"
platform_backup_line="$(line_of 'CREATE TEMP TABLE dramaforge_platform_api_configs_backup')"
provider_backup_line="$(line_of 'CREATE TEMP TABLE dramaforge_provider_files_backup')"
truncate_line="$(line_of 'TRUNCATE public.payment_orders,public.provider_files,')"
dump_line="$(line_of '-- fake app1 data dump')"
normalize_line="$(line_of "SET phone = '+86' || phone")"
check_line="$(line_of 'ADD CONSTRAINT users_phone_format_check')"
platform_restore_line="$(line_of 'INSERT INTO public.api_configs')"
provider_restore_line="$(line_of 'INSERT INTO public.provider_files')"
payment_restore_line="$(line_of 'INSERT INTO public.payment_orders')"

(( backup_line < truncate_line )) || fail "payment backup must precede truncate"
(( platform_backup_line < truncate_line )) || fail "platform key backup must precede truncate"
(( provider_backup_line < truncate_line )) || fail "provider file backup must precede truncate"
(( truncate_line < dump_line )) || fail "truncate must precede source restore"
(( dump_line < normalize_line )) || fail "phone normalization must follow source restore"
(( normalize_line < check_line )) || fail "phone CHECK must follow normalization"
(( check_line < platform_restore_line )) || fail "platform keys must restore after source data"
(( platform_restore_line < provider_restore_line )) || fail "keys must restore before provider mappings"
(( provider_restore_line < payment_restore_line )) || fail "provider mappings must restore before orders"
(( check_line < payment_restore_line )) || fail "payment restore must follow user validation"

# pipefail must propagate a psql/docker failure so callers never report a
# partial restore as successful. PostgreSQL rollback itself is provided by
# --single-transaction, asserted above.
if MIGRATE_TEST_DOCKER_FAIL=1 DUMP_FILE="$dump_file" \
  bash "$SCRIPT" restore local >/dev/null 2>&1; then
  fail "restore unexpectedly succeeded when psql/docker failed"
fi

echo "PASS: migrate-app1-data.sh safety contract"
