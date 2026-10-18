#!/usr/bin/env bash
set -u

output_path="${1:?output path required}"
interval="${2:-5}"

while true; do
  ts="$(date -Is)"
  load1="$(awk '{print $1}' /proc/loadavg)"
  mem_available_kb="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
  swap_free_kb="$(awk '/SwapFree:/ {print $2}' /proc/meminfo)"
  echo "T|${ts}|${load1}|${mem_available_kb}|${swap_free_kb}" >> "${output_path}"
  docker stats --no-stream --format 'D|{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.PIDs}}' \
    dramaforge-web dramaforge-ai-worker dramaforge-postgres dramaforge-redis dramaforge-minio >> "${output_path}" 2>/dev/null || true
  docker exec dramaforge-postgres psql -U postgres -d dramaforge -Atc \
    "select 'P|' || count(*) || '|' || count(*) filter (where state='active') || '|' || count(*) filter (where wait_event is not null) from pg_stat_activity;" \
    >> "${output_path}" 2>/dev/null || true
  docker exec dramaforge-redis redis-cli --raw INFO clients memory stats 2>/dev/null \
    | grep -E '^(connected_clients|blocked_clients|used_memory:|instantaneous_ops_per_sec|rejected_connections|evicted_keys):' \
    | tr '\n' ' ' | sed 's/^/R|/; s/[[:space:]]*$//' >> "${output_path}" || true
  echo >> "${output_path}"
  sleep "${interval}"
done
