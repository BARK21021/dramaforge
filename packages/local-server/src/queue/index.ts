import { EventEmitter } from 'events';
import type { Database } from 'better-sqlite3';

/**
 * In-process task queue �� replaces Redis/BullMQ.
 * Uses SQLite for persistence; EventEmitter for notifications.
 * The local Electron client's render-worker already polls /api/render/jobs/next,
 * so this just needs to make jobs available in the DB.
 */

export interface QueueJob {
  id: string;
  taskId: string;
  userId: string;
  queueName: string;
  data: Record<string, unknown>;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export function notifyNewJob(): void {
  emitter.emit('new-job');
}

export function waitForJob(timeoutMs: number = 30000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(); }, timeoutMs);
    emitter.once('new-job', () => { clearTimeout(timer); resolve(); });
  });
}

/** Publish a task event to task_events table + emit for SSE listeners. */
export function publishTaskEvent(
  db: Database,
  taskId: string,
  type: string,
  data: Record<string, unknown>,
): void {
  const { randomUUID } = require('crypto');
  db.prepare(
    'INSERT INTO task_events (id, "taskId", type, data, "createdAt") VALUES (?, ?, ?, ?, datetime(\'now\'))'
  ).run(randomUUID(), taskId, type, JSON.stringify(data));
  emitter.emit(`task:${taskId}`, { type, data });
}

/** Subscribe to task events for SSE. */
export function onTaskEvent(taskId: string, cb: (event: { type: string; data: Record<string, unknown> }) => void): () => void {
  emitter.on(`task:${taskId}`, cb);
  return () => emitter.off(`task:${taskId}`, cb);
}

/** List events after a given cursor for SSE reconnect. */
export function listEventsAfter(db: Database, taskId: string, afterId: string | null) {
  if (afterId) {
    return db.prepare(
      'SELECT * FROM task_events WHERE "taskId" = ? AND id > ? ORDER BY "createdAt" ASC'
    ).all(taskId, afterId);
  }
  return db.prepare(
    'SELECT * FROM task_events WHERE "taskId" = ? ORDER BY "createdAt" ASC'
  ).all(taskId);
}