#!/bin/bash
# =============================================================================
# dramaforge-secmon.sh — dramaforge 生产服务器 短暂安全/健康巡检（2026-07-23 实战期临时装）
# =============================================================================
# 防御用途：检测 CPU/内存/磁盘异常、挖矿木马进程、非预期监听端口、非预期
# Docker 容器、SSH 暴破、key-only 服务器上出现密码登录（=入侵强信号）。
# 每次运行输出一行摘要到 /var/log/dramaforge-secmon.log，异常时追加 [ALERT] 明细。
#
# 部署：scp 到 /opt/dramaforge/scripts/ + chmod +x + root crontab 每5min
# 卸载（短暂用完）：crontab -e 删掉本脚本那行即可，脚本/日志可留可删。
#
# 服务器画像：阿里云 al8 / 2 核 / 1.8GB / 公网端口 22,80,443 / SSH key-only
# =============================================================================

LOG=/var/log/dramaforge-secmon.log
# 自封顶兜底（防 logrotate 万一没跑）：日志 >2MB 时只留末尾 800 行
if [ -f "$LOG" ]; then
  SZ=$(stat -c%s "$LOG" 2>/dev/null || echo 0)
  if [ "$SZ" -gt 2097152 ]; then
    tail -800 "$LOG" > "${LOG}.tmp" 2>/dev/null && mv "${LOG}.tmp" "$LOG"
  fi
fi
TS=$(date '+%Y-%m-%d %H:%M:%S')
CORES=$(nproc)
ALERTS=""
DETAIL=""

# 阈值（2 核 / 1.8GB 机器）
LOAD_THRESH=$((CORES * 3))   # 1min 负载 > 核数×3 算异常（生图生视频正常峰值低于此）
MEM_FLOOR_MB=80              # 可用内存 < 80MB 告警（OOM 预警）
DISK_PCT=90                  # 任一文件系统使用率 > 90%
ESTAB_CEIL=300               # ESTABLISHED 连接 > 300（DDoS 僵尸/C2/异常外联）
SSH_FAIL_10M=30              # 近10min Failed password > 30（暴破，fail2ban 应已拦）
EXPECT_PUB_PORTS="22|80|443" # 公网监听端口白名单（3000 只绑 127.0.0.1 不算公网）
EXPECT_CONTAINERS="dramaforge-web|dramaforge-ai-worker|dramaforge-postgres|dramaforge-redis|dramaforge-minio"

# 挖矿木马/IOC 进程名（强信号，命中即 CRITICAL）
MINERS="xmrig|kdevtmpfsi|kinsing|cnrig|minerd|bashd|kthrotlds|sysupdate|sysguard|networkservice|pnscan|ddgs|qW3xT|kinsing|donate|stratum|pool"

# ---- 1. 负载 ----
LOAD1=$(awk '{print $1}' /proc/loadavg)
if awk "BEGIN{exit !($LOAD1 > $LOAD_THRESH)}"; then
  ALERTS="$ALERTS load=${LOAD1}>${LOAD_THRESH}"
fi

# ---- 2. 内存 ----
MEM_AVAIL_MB=$(($(awk '/MemAvailable/{print $2}' /proc/meminfo) / 1024))
if [ "${MEM_AVAIL_MB:-9999}" -lt "$MEM_FLOOR_MB" ]; then
  ALERTS="$ALERTS mem_avail=${MEM_AVAIL_MB}MB<${MEM_FLOOR_MB}"
fi

# ---- 3. 磁盘 ----
DISK_WARN=$(df -P 2>/dev/null | awk -v p="$DISK_PCT" 'NR>1{u=$5; gsub(/%/,"",u); if(u+0>p) print $6"@"u"%"}' | tr '\n' ',' | sed 's/,$//')
[ -n "$DISK_WARN" ] && ALERTS="$ALERTS disk_full=${DISK_WARN}"

# ---- 4. 挖矿进程扫描（CRITICAL）----
MINER_HIT=$(ps -eo pid,comm,args 2>/dev/null | grep -iE "$MINERS" | grep -vE "grep|dramaforge-secmon" | head -5)
if [ -n "$MINER_HIT" ]; then
  ALERTS="$ALERTS [CRITICAL]MINER_PROC"
  DETAIL="$DETAIL\n  MINER: $(echo "$MINER_HIT" | tr '\n' '|')"
fi

# ---- 5. 单进程高 CPU（>85%，列前3）----
TOPCPU=$(ps -eo pcpu,comm --sort=-pcpu 2>/dev/null | awk 'NR>1 && $1+0>85{print $2"="$1"%"; c++} c>=3{exit}' | tr '\n' ',' | sed 's/,$//')
[ -n "$TOPCPU" ] && ALERTS="$ALERTS topcpu=${TOPCPU}"

# ---- 6. ESTABLISHED 连接数 ----
ESTAB=$(ss -tan state established 2>/dev/null | wc -l)
if [ "${ESTAB:-0}" -gt "$ESTAB_CEIL" ]; then
  ALERTS="$ALERTS estab=${ESTAB}>${ESTAB_CEIL}"
  TOPFOREIGN=$(ss -tan state established 2>/dev/null | awk 'NR>1{split($5,a,":"); print a[1]}' | sort | uniq -c | sort -rn | head -5 | tr '\n' ';' )
  DETAIL="$DETAIL\n  TOP_FOREIGN_IPs: $TOPFOREIGN"
fi

# ---- 7. 非预期公网监听端口 ----
BADPORT=$(ss -tlnH 2>/dev/null | awk '$4 ~ /0\.0\.0\.0:|\*:/ || $4 ~ /:::/{n=split($4,a,":"); print a[n]}' | sort -u | grep -vE "^($EXPECT_PUB_PORTS)$" | tr '\n' ',' | sed 's/,$//')
[ -n "$BADPORT" ] && ALERTS="$ALERTS unexpected_listen=${BADPORT}"

# ---- 8. 非预期 Docker 容器（攻击者植入新容器）----
if command -v docker >/dev/null 2>&1; then
  BADCTR=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -vE "^($EXPECT_CONTAINERS)$" | tr '\n' ',' | sed 's/,$//')
  [ -n "$BADCTR" ] && ALERTS="$ALERTS unexpected_container=${BADCTR}"
fi

# ---- 9. SSH 近10min 暴破 ----
if command -v journalctl >/dev/null 2>&1; then
  FAIL10=$(journalctl _COMM=sshd --since "10 min ago" --no-pager 2>/dev/null | grep -c "Failed password")
else
  FAIL10=$(grep "Failed password" /var/log/secure 2>/dev/null | tail -100 | wc -l)
fi
[ "${FAIL10:-0}" -gt "$SSH_FAIL_10M" ] && ALERTS="$ALERTS ssh_bruteforce=${FAIL10}/10min"

# ---- 10. key-only 服务器出现密码登录（强入侵信号）----
ACCEPTED_PW=$(journalctl _COMM=sshd --since "1 hour ago" --no-pager 2>/dev/null | grep -c "Accepted password")
if [ "${ACCEPTED_PW:-0}" -gt 0 ]; then
  ALERTS="$ALERTS [CRITICAL]ACCEPTED_PASSWORD_LOGIN"
  DETAIL="$DETAIL\n  RECENT_PW_LOGINS: $(journalctl _COMM=sshd --since '1 hour ago' --no-pager 2>/dev/null | grep 'Accepted password' | tail -3 | tr '\n' '|')"
fi

# ---- 输出 ----
DISK_ROOT=$(df -P / 2>/dev/null | awk 'NR==2{print $5}')
SUMMARY="load=${LOAD1} mem_avail=${MEM_AVAIL_MB}MB disk/=${DISK_ROOT} conn=${ESTAB} sshfail10m=${FAIL10:-0}"
if [ -n "$ALERTS" ]; then
  # 异常：stdout + 日志 + syslog（stdout 供 cron mail，syslog 供事后查）
  LINE="[ALERT $TS]$ALERTS | $SUMMARY$(printf '%b' "$DETAIL")"
  echo "$LINE" | tee -a "$LOG"
  logger -t dramaforge-secmon "$LINE" 2>/dev/null
else
  # 正常：每次写一行 OK 摘要到日志（5min 一行审计轨迹，便于 tail 确认巡检活着）
  echo "[OK $TS] $SUMMARY" >> "$LOG"
fi
