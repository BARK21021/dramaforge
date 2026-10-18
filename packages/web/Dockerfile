# syntax=docker/dockerfile:1
# =============================================================================
# DramaForge Web (Next.js) Dockerfile — multi-stage
# =============================================================================
#
# Build context = repo root:
#   docker build -f packages/web/Dockerfile -t dramaforge-cs-web .
#
# 三阶段：
#   deps    — pnpm install (frozen lockfile，含 workspace 依赖)
#   builder — next build (产出 .next/)
#   runner  — 精简 runtime (node + .next + node_modules)
#
# 注意：next.config.mjs 未启用 output:'standalone'（不改已提交源码），
# runner 阶段需携带 node_modules。未来启用 standalone 可大幅缩小镜像。
# =============================================================================

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# --- deps: 安装 workspace 全量依赖（frozen lockfile） ---
FROM base AS deps
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/client/package.json packages/client/package.json
# 全量安装（web 依赖 server+shared，server 依赖 shared）。
# node-linker=hoisted：同 server Dockerfile——pg 是 server 的依赖（非 web 直接依赖），
# pnpm 默认 isolated 布局下 pg 符号链接在 packages/server/node_modules，web 运行时
# 从 /app/packages/web 解析 import 'pg' 找不到（实测 web pg FAIL）。hoisted 平铺到
# 根 node_modules，runner COPY /app/node_modules 即可带上。仅 Docker 构建生效。
RUN pnpm install --frozen-lockfile --config.node-linker=hoisted

# --- builder: next build ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/ ./
COPY . .
# next build 收集 page data 时会 import 路由模块 → 触发 @server/infra env() 调用
# （pg/redis 等在模块顶层调 env()）。build 时无 .env，给占位值让校验过；
# 均为非 NEXT_PUBLIC_ 服务端变量，不 bake 进客户端产物，runtime 由 compose env_file 注入真实值。
ENV DATABASE_URL=postgres://build:build@build:5432/build \
    REDIS_URL=redis://build:6379 \
    MINIO_ENDPOINT=build \
    MINIO_ACCESS_KEY=build \
    MINIO_SECRET_KEY=build \
    MINIO_BUCKET=build \
    NEXTAUTH_SECRET=build-placeholder-not-used-at-runtime \
    NEXTAUTH_URL=http://build.local
# 只 build web（next build）；transpilePackages 会编译 @dramaforge/server + shared
RUN pnpm --filter '@dramaforge/web' build

# --- runner: 精简 runtime ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# 非 root 用户
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 nextjs

# 复制 web 构建产物 + 运行时依赖
# node_modules 全量拷贝（未启用 standalone 的折衷）
COPY --from=builder /app/packages/web/.next ./packages/web/.next
COPY --from=builder /app/packages/web/public ./packages/web/public
COPY --from=builder /app/packages/web/package.json ./packages/web/package.json
# `next start` 会在运行时重新读取配置；缺少此文件会静默退回 10MiB 代理默认值。
COPY --from=builder /app/packages/web/next.config.mjs ./packages/web/next.config.mjs
COPY --from=builder /app/packages/web/node_modules ./packages/web/node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/packages/server ./packages/server
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./

WORKDIR /app/packages/web
USER nextjs

EXPOSE 3000
# next start 监听 3000（HOSTNAME=0.0.0.0 确保容器内可访问）
CMD ["npx", "next", "start"]
