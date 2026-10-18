// Vitest config for @dramaforge/web.
// Contract tests mock @dramaforge/server, next-auth, and ioredis — no real
// DB/Redis/AI is touched. Node environment (route handlers run on the server).
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const webRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    // `app/**/*.test.ts` 让与源码共置的单测（如 app/auth/signin/login-identifier.test.ts）
    // 也被 vitest 发现；components/**/*.test.{ts,tsx} 覆盖 UI 组件测试
    // （react-test-renderer，node 环境即可）；其余契约测试仍在 test/ 下。
    include: ['test/**/*.test.ts', 'app/**/*.test.ts', 'components/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    globals: true,
    restoreMocks: true,
  },
  resolve: {
    alias: [
      // @web/* → packages/web/* (tsconfig paths 不被 vitest 自动读取)
      { find: /^@web\//, replacement: webRoot + path.sep },
      // @dramaforge/server / @dramaforge/shared 走 TS 源；vi.mock 优先拦截。
      {
        find: /^@dramaforge\/server$/,
        replacement: fileURLToPath(new URL('../server/src/index.ts', import.meta.url)),
      },
      {
        find: /^@dramaforge\/shared$/,
        replacement: fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      },
      // Pure server-domain contract tests may import a leaf module directly;
      // preserve that module's internal @shared/* aliases without loading the DB-facing server index.
      {
        find: /^@shared\/(.*)$/,
        replacement: fileURLToPath(new URL('../shared/src/', import.meta.url)) + '$1',
      },
      {
        find: /^@server\/(.*)$/,
        replacement: fileURLToPath(new URL('../server/src/', import.meta.url)) + '$1',
      },
    ],
  },
  esbuild: {
    // 与 next/react 的 automatic JSX runtime 一致：组件测试（.tsx）无需
    // import React；源码 .tsx（如依赖 next automatic runtime 的 Toast.tsx）
    // 也能被 vitest 直接渲染（react-test-renderer）。
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
});
