# syntax=docker/dockerfile:1
# =============================================================================
# DramaForge AI Worker Dockerfile — multi-stage
# =============================================================================
#
# Build context = repo root:
#   docker build -f packages/server/Dockerfile -t dramaforge-cs-ai-worker .
#
# 三阶段：
#   deps    — pnpm install (仅 server+shared 依赖)
#   builder — esbuild bundle (ai-worker 入口 + migrate runner → dist/)
#   runner  — 精简 runtime (node + dist + node_modules)
#
# 为什么用 esbuild 而非 tsc emit：
#   server src 大量使用 @server/* 和 @shared/* 路径别名（见 tsconfig.base.json
#   paths），tsc emit 不解析别名，产出的 .js 里 require('@server/...') 在
#   Node 运行时无法解析。esbuild bundle 在构建时解析别名 + 内联所有 workspace
#   源码，产出单文件 .js，runtime 只需 external 的 npm 包（pg/ioredis/bullmq/
#   minio 等）在 node_modules 中。
#
# 纯 Node，无 ffmpeg——ffmpeg 只在客户端 Electron 中运行。
# =============================================================================

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# --- deps: 安装 server + shared 依赖 ---
FROM base AS deps
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
# 只装 server 及其 workspace 依赖（shared）。
# node-linker=hoisted：pnpm 默认 isolated 布局把每个包的依赖符号链接到
# packages/server/node_modules，而 runner 只 COPY 根 node_modules（含 .pnpm store
# 但无 pg/ioredis/bullmq/minio 等顶层入口）→ runtime import 'pg' 解析失败
# （ERR_MODULE_NOT_FOUND，曾导致 cutover [6] migrate 失败）。hoisted 让依赖平铺
# 到根 node_modules（如 npm），runner 的 COPY /app/node_modules 才能带上所有
# external 包。仅此 Docker 构建生效，不影响本地客户端 pnpm 布局。
RUN pnpm install --frozen-lockfile --config.node-linker=hoisted --filter '@dramaforge/server...' --filter '@dramaforge/shared'

# --- builder: esbuild bundle ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/ ./
COPY . .
# esbuild bundle: src/ai-worker/index.ts → dist/ai-worker/index.js
#                 src/infra/migrate.ts    → dist/migrate.js (含 runner 入口)
# 虚拟入口调用 startAllWorkers / runMigrations
RUN pnpm --filter '@dramaforge/server' build

# --- runner: 精简 runtime ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

# 非 root 用户：复用 node:22-alpine 自带 node 用户（UID/GID 1000）。
# 不 addgroup node——镜像已有 node 组，重建同名组冲突（exit 1）。


# 复制 bundle 产物 + external 依赖的 node_modules
COPY --from=builder /app/packages/server/dist ./dist
COPY --from=builder /app/packages/server/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared

USER node

# 默认 CMD：启动 ai-worker（消费 BullMQ 队列）
# migrate 通过 docker compose --profile migrate 覆盖 command 运行
CMD ["node", "dist/ai-worker/index.js"]
