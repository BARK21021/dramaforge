@echo off
setlocal
:: =====================================================================
:: run-local-detached.bat
:: 本地版"独立实例"启动：偏移端口 + 独立数据目录
:: 与云端 dev（D:\dramaforge-cs 的 docker 5432/6379/9000 + web 3000）零冲突。
:: 所有数据落 D:\DramaForgeLocal\data —— 删这里不影响 dev，反之亦然。
::
:: 产物依赖（需已构建）：
::   - web standalone : packages\web\.next\standalone\       (pnpm --filter @dramaforge/web build:standalone)
::   - local-server   : packages\local-server\dist\index.cjs (pnpm --filter @dramaforge/local-server build)
:: =====================================================================

set "DRAMAFORGE_REPO=D:\dramaforge-cs"
set "DRAMAFORGE_LOCAL_DATA=D:\DramaForgeLocal\data"

:: 偏移端口——刻意避开 dev 占用的 3000 / 5432 / 6379 / 9000
set "WEB_PORT=13000"
set "FASTIFY_PORT=17519"

if not exist "%DRAMAFORGE_LOCAL_DATA%" mkdir "%DRAMAFORGE_LOCAL_DATA%"
echo [local] data dir = %DRAMAFORGE_LOCAL_DATA%
echo [local] web : http://127.0.0.1:%WEB_PORT%   (API 代理到 Fastify :%FASTIFY_PORT%)

:: --- 进程 1：Fastify local-server（SQLite + BYOK + license），独立数据目录 ---
set "STARFRAME_DATA_DIR=%DRAMAFORGE_LOCAL_DATA%"
set "PORT=%FASTIFY_PORT%"
start "dramaforge-local-fastify" /min cmd /c "node \"%DRAMAFORGE_REPO%\packages\local-server\dist\index.cjs\""

:: 等 Fastify 起来
timeout /t 3 /nobreak >nul

:: --- 进程 2：web standalone（页面 + /api/* 代理到上面的 Fastify）---
set "PORT=%WEB_PORT%"
set "STARFRAME_FASTIFY_PORT=%FASTIFY_PORT%"
pushd "%DRAMAFORGE_REPO%\packages\web\.next\standalone\packages\web"
echo [local] 启动 web standalone（Ctrl+C 关闭；Fastify 在独立最小化窗口）
node server.js
popd
endlocal
