// ============================================================
// web/test/setup — vitest 全局 setup
// ============================================================
//
// 每个测试文件运行前执行。导入 mocks.ts 注册 @dramaforge/server 与
// next-auth 的全局 mock。restoreMocks: true（vitest.config）会在每个测试
// 之间清空 mock 调用记录但不清除实现（mockResolvedValue 等保留需手动 reset）。
//
// web 禁止 import 任何 ffmpeg 模块。
// ============================================================

import './mocks';

// 静默 console.warn（publish 失败时的告警噪音），保留 error
const origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const first = String(args[0] ?? '');
  if (first.includes('[web]') || first.includes('[redis]') || first.includes('[sse]')) {
    return; // 抑制 mock 触发的预期告警
  }
  origWarn(...args);
};

// 静默 handleApiError 在测试中触发的预期 500 日志（response.test.ts 故意抛错驱动兜底分支）
const origError = console.error;
console.error = (...args: unknown[]) => {
  const first = String(args[0] ?? '');
  if (first.includes('[handleApiError]')) {
    return; // 测试驱动 fallback 分支时的预期日志
  }
  origError(...args);
};
