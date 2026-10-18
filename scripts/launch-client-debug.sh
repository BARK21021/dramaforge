#!/usr/bin/env bash
# =============================================================================
# launch-client-debug.sh — 以 CDP 调试口启动 DramaForge CS 客户端
# =============================================================================
# 给 playwright-cs MCP 挂载用（--cdp-endpoint http://localhost:9222）。
# 客户端是 Electron=Chromium，开 --remote-debugging-port 后即可选择器级驱动
# （不是视觉 RPA，精度等同 web Playwright）。
#
# 用法：bash scripts/launch-client-debug.sh
#   客户端路径默认 D:\dramaforge\DramaForge CS\DramaForge CS.exe（Desktop .lnk 解析），
#   可用 DRAMAFORGE_CLIENT_EXE 环境变量覆盖。
#
# ⚠ 安全：--remote-debugging-port=9222 把你「已登录」的会话暴露在 localhost:9222，
#   任何本机进程都能经 CDP 操控客户端。仅本机调试用，用完正常关闭客户端。
# =============================================================================
set -euo pipefail

EXE="${DRAMAFORGE_CLIENT_EXE:-D:/dramaforge/DramaForge CS/DramaForge CS.exe}"

if [ ! -f "$EXE" ]; then
  echo "[FAIL] client not found: $EXE" >&2
  echo "       set DRAMAFORGE_CLIENT_EXE to your install path." >&2
  exit 1
fi

# 单实例锁：若已有实例在跑，新进程会被锁退出且 9222 永不打开 → 必须先关旧的。
running="$(powershell.exe -NoProfile -Command "(Get-Process -Name 'DramaForge CS' -ErrorAction SilentlyContinue | Measure-Object).Count" 2>/dev/null | tr -d '[:space:]')"
if [ -n "$running" ] && [ "$running" != "0" ]; then
  echo "[FAIL] DramaForge CS is already running ($running process(es))." >&2
  echo "       Single-instance lock: a 2nd launch will NOT open port 9222." >&2
  echo "       Close the running client first, then re-run this script." >&2
  exit 1
fi

echo "[OK] launching client with --remote-debugging-port=9222 ..."
# stdio 重定向到日志文件（而非继承脚本终端管道）：后台 disown 后，启动它的 Git Bash
# 终端一旦关闭，主进程 stdout/stderr 管道即断裂，下一次 console.warn/error 写入就会
# 抛 EPIPE → 无 handler → 弹「A JavaScript error occurred in the main process」崩溃框。
# 重定向到普通文件，FD 永不断裂，根治 EPIPE，并保留主进程调试日志。
LOG_FILE="${DRAMAFORGE_DEBUG_LOG:-$HOME/.dramaforge-debug.log}"
echo "     stdio -> $LOG_FILE"
"$EXE" --remote-debugging-port=9222 >"$LOG_FILE" 2>&1 &
disown 2>/dev/null || true
echo "[OK] launched in background."
echo "     Verify: open http://localhost:9222 in a browser — should list a debuggable target."
echo "     Then in Claude Code: /mcp reconnect playwright-cs  (or restart Claude Code)."
echo "     After that, mcp__playwright-cs__* tools drive your live client."
