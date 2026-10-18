// Vitest config for @dramaforge/server.
//
// Repository history: server tests originally only imported TYPES from @shared/*
// (erased at compile time) and MOCKED all @server/* + @shared/utils value imports,
// so they ran without alias resolution. The project subdomain legitimately imports
// a Zod schema (value) from @shared/project, which forces vitest to resolve the
// alias for real. Without this config, vitest fails with:
//   "Failed to load url @shared/project ... Does the file exist?"
//
// Approach mirrors packages/web/vitest.config.ts: alias @shared/* + @server/* to
// TS source. vi.mock still takes precedence for tests that want to stub modules.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(serverRoot, '../..');

export default defineConfig({
  test: {
    environment: 'node',
    // 包含 test/ 下的传统测试 + 与源码共置的单测（如 src/domain/project/service.test.ts）
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
  resolve: {
    alias: [
      // tsconfig paths 不被 vitest 自动读取，需手动 alias
      {
        find: /^@shared\/(.*)$/,
        replacement: path.join(monorepoRoot, 'packages/shared/src/$1'),
      },
      {
        find: /^@server\/(.*)$/,
        replacement: path.join(serverRoot, 'src/$1'),
      },
    ],
  },
});
