// ============================================================
// web/lib/publish — Redis task:events 事件发布（re-export 自 @server）
// ============================================================
//
// 文件职责：
//   publishTaskEvent(payload) — 向 Redis `task:events` 频道发布任务事件，
//   供 ⑤ /api/sse 订阅转发给前端。底层实现复用 ④ @server/task/event-publisher，
//   自动持久化到 PG task_events 表（支持 Last-Event-ID 重放）+ Redis publish。
//
// 设计要点：
//   - 此前 web 独立维护一份仅 redis.publish 的实现；与 server ④ 双写。
//     现统一 re-export 自 @dramaforge/server 根 barrel，避免双写漂移。
//   - 现有 import 路径 '@web/lib/publish' 不变（result/failed/progress route
//     与对应测试 vi.mock('@web/lib/publish', ...) 继续工作）。
//   - publish 失败仅 console.warn，不阻断主流程（任务状态已写 PG，前端可轮询兜底）。
//
// 与 ⑥ ai-worker/event-publisher 的关系：
//   两者都是 re-export shim，真实实现在 ④ @server/task/event-publisher.ts。
//   ai-worker 模块保持 shim 是为绕过 worker-bootstrap 副作用（dispatch.ts:27）；
//   web 模块保持 shim 是为不破坏现有 '@web/lib/publish' import 路径。
//
// web 禁止 import 任何 ffmpeg 模块。
// ============================================================

export { publishTaskEvent } from '@dramaforge/server';
