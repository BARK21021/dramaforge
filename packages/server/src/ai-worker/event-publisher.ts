// ============================================================
// ⑥ server/ai-worker/event-publisher — re-export shim
// ============================================================
//
// 文件职责：
//   真实实现已移至 ④ ../task/event-publisher.ts（PG task_events 持久化 +
//   Redis publish + listEventsAfter + listActiveTasksSnapshot）。本文件保留为
//   re-export shim，确保以下 import 路径不破：
//     - ./processor.ts（同模块内 ai-worker 自用）
//     - ../task/dispatch.ts（task 子域用，绕过本模块 index.ts 的 worker-bootstrap
//       副作用，详见 dispatch.ts:27 注释）
//     - 测试 vi.mock('../../src/ai-worker/event-publisher') 路径
//
// 设计要点：
//   - 只 re-export，零副作用（不创建 BullMQ Worker、不连 Redis）
//   - 频道名常量 TASK_EVENTS_CHANNEL 跟随真实实现
//   - 想用 listEventsAfter / listActiveTasksSnapshot 请直引 @server/task 或
//     经 @dramaforge/server 根 barrel；本 shim 只透传 publishTaskEvent 与频道名
//
// 服务器禁止 import ffmpeg；本模块仅做符号透传。
// ============================================================

export { publishTaskEvent, TASK_EVENTS_CHANNEL } from '../task/event-publisher';
