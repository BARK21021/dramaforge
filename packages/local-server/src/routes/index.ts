/**
 * API route handlers for local server.
 * Implements the same endpoints as the Next.js API routes,
 * backed by SQLite.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { LocalStorage } from '../storage';
import { randomUUID } from 'crypto';
import { registerUser, loginUser, createToken, verifyToken, getUserById, SESSION_COOKIE } from '../auth';
import { publishTaskEvent, onTaskEvent, listEventsAfter, notifyNewJob } from '../queue';
import { localCallAI, parseModelId, LocalGatewayError, getSupportedProviders } from '../gateway';

interface RouteCtx {
  db: Database;
  storage: LocalStorage;
  dataDir: string;
}

// ============================================================
// Helpers
// ============================================================

function parseJSON(val: unknown): unknown {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val;
}

function parseRow(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!row) return null;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    result[key] = val;
    // Auto-parse JSON columns
    if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
      try { result[key] = JSON.parse(val); } catch { /* keep string */ }
    }
  }
  return result;
}

function parseRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(parseRow).filter(Boolean) as Record<string, unknown>[];
}

/** Get authenticated user ID from request cookie. */
function getUserId(req: FastifyRequest): string | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const payload = verifyToken(token);
  return payload?.sub ?? null;
}

/** Require auth — returns userId or sends 401. */
function requireAuth(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = getUserId(req);
  if (!userId) {
    reply.code(401).send({ success: false, code: 'UNAUTHORIZED', error: 'Not authenticated' });
    return null;
  }
  return userId;
}

function success(data: unknown) {
  return { success: true, data };
}

function fail(error: string, code: string = 'ERROR', status: number = 400) {
  return { success: false, error, code, status };
}

// ============================================================
// Register all routes
// ============================================================

export function registerRoutes(fastify: FastifyInstance, ctx: RouteCtx) {
  const { db, storage, dataDir } = ctx;

  // ---- Health ----
  fastify.get('/api/health', async () => ({ success: true, data: { status: 'ok', mode: 'local' } }));

  // ---- Auth: Register ----
  fastify.post('/api/auth/register', async (req: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) return reply.code(400).send(fail('Missing username or password'));
    if (password.length < 6) return reply.code(400).send(fail('Password must be at least 6 characters'));
    try {
      const { user, token } = registerUser(db, username, password);
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60,
        path: '/',
      });
      return reply.send(success({ user, token }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'USERNAME_TAKEN') return reply.code(409).send(fail('Username already taken'));
      return reply.code(500).send(fail(msg));
    }
  });

  // ---- Auth: Login ----
  fastify.post('/api/auth/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) return reply.code(400).send(fail('Missing username or password'));
    try {
      const { user, token } = loginUser(db, username, password);
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60,
        path: '/',
      });
      return reply.send(success({ user, token }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'USER_NOT_FOUND' || msg === 'WRONG_PASSWORD') {
        return reply.code(401).send(fail('Invalid username or password', 'INVALID_CREDENTIALS'));
      }
      return reply.code(500).send(fail(msg));
    }
  });

  // ---- Auth: Logout ----
  fastify.post('/api/auth/logout', async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send(success({}));
  });

  // ---- Auth: Session ----
  fastify.get('/api/auth/session', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = getUserId(req);
    if (!userId) return reply.send({ success: true, data: null });
    const user = getUserById(db, userId);
    if (!user) return reply.send({ success: true, data: null });
    return reply.send(success({ user }));
  });

  // ---- Projects ----
  fastify.get('/api/projects', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const rows = db.prepare(
      'SELECT * FROM projects WHERE "userId" = ? ORDER BY "updatedAt" DESC'
    ).all(userId) as Record<string, unknown>[];
    return reply.send(success(parseRows(rows)));
  });

  fastify.post('/api/projects', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const body = req.body as Record<string, unknown>;
    const id = randomUUID();
    db.prepare(
      'INSERT INTO projects (id, "userId", title, description, "scriptData", "artStyle", category, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))'
    ).run(
      id, userId, body.title ?? 'Untitled', body.description ?? null,
      body.scriptData ? JSON.stringify(body.scriptData) : null,
      (body.artStyle as string) ?? null,
      (body.category as string) ?? 'DOMESTIC'
    );
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown>;
    return reply.send(success(parseRow(row)));
  });

  fastify.get('/api/projects/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply); if (!reply.sent) {} // auth check
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send(fail('Project not found', 'NOT_FOUND', 404));
    return reply.send(success(parseRow(row)));
  });

  fastify.patch('/api/projects/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (['title', 'description', 'artStyle', 'status', 'category'].includes(k)) {
        sets.push(`"${k}" = ?`); vals.push(v);
      } else if (k === 'scriptData') {
        sets.push('"scriptData" = ?'); vals.push(JSON.stringify(v));
      }
    }
    if (sets.length === 0) return reply.send(success({}));
    sets.push('"updatedAt" = datetime(\'now\')');
    vals.push(id);
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown>;
    return reply.send(success(parseRow(row)));
  });

  fastify.delete('/api/projects/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return reply.send(success({}));
  });

  // ---- Episodes ----
  fastify.get('/api/projects/:id/episodes', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const rows = db.prepare(
      'SELECT * FROM episodes WHERE "projectId" = ? ORDER BY "sortOrder" ASC, "episodeNumber" ASC'
    ).all(id) as Record<string, unknown>[];
    return reply.send(success(parseRows(rows)));
  });

  fastify.post('/api/projects/:id/episodes', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const epId = randomUUID();
    db.prepare(
      'INSERT INTO episodes (id, "projectId", title, "scriptData", "episodeNumber", "sortOrder", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))'
    ).run(
      epId, id, body.title ?? 'New Episode',
      body.scriptData ? JSON.stringify(body.scriptData) : null,
      (body.episodeNumber as number) ?? null,
      (body.sortOrder as number) ?? 0
    );
    const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(epId) as Record<string, unknown>;
    return reply.send(success(parseRow(row)));
  });

  fastify.get('/api/projects/:id/episodes/:episodeId', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { episodeId } = req.params as { episodeId: string };
    const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send(fail('Episode not found', 'NOT_FOUND', 404));
    return reply.send(success(parseRow(row)));
  });

  fastify.patch('/api/projects/:id/episodes/:episodeId', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { episodeId } = req.params as { episodeId: string };
    const body = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (['title', 'episodeNumber', 'sortOrder', 'status'].includes(k)) {
        sets.push(`"${k}" = ?`); vals.push(v);
      } else if (k === 'scriptData') {
        sets.push('"scriptData" = ?'); vals.push(JSON.stringify(v));
      }
    }
    if (sets.length === 0) return reply.send(success({}));
    sets.push('"updatedAt" = datetime(\'now\')');
    vals.push(episodeId);
    db.prepare(`UPDATE episodes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId) as Record<string, unknown>;
    return reply.send(success(parseRow(row)));
  });

  fastify.delete('/api/projects/:id/episodes/:episodeId', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { episodeId } = req.params as { episodeId: string };
    db.prepare('DELETE FROM episodes WHERE id = ?').run(episodeId);
    return reply.send(success({}));
  });

  // ---- Shots ----
  fastify.get('/api/projects/:id/episodes/:episodeId/shots', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { id, episodeId } = req.params as { id: string; episodeId: string };
    const rows = db.prepare(
      'SELECT * FROM shots WHERE "projectId" = ? AND "episodeId" = ? ORDER BY "sortOrder" ASC, "shotIndex" ASC'
    ).all(id, episodeId) as Record<string, unknown>[];
    return reply.send(success(parseRows(rows)));
  });

  fastify.post('/api/projects/:id/episodes/:episodeId/shots', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { id, episodeId } = req.params as { id: string; episodeId: string };
    const body = req.body as Record<string, unknown>;
    const shotId = randomUUID();
    db.prepare(
      'INSERT INTO shots (id, "projectId", "episodeId", "shotIndex", "shotSeq", "durationSeconds", "visualPrompt", "aspectRatio", "sortOrder", metadata, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))'
    ).run(
      shotId, id, episodeId,
      (body.shotIndex as number) ?? 0,
      (body.shotSeq as string) ?? null,
      (body.durationSeconds as number) ?? null,
      (body.visualPrompt as string) ?? null,
      (body.aspectRatio as string) ?? '9:16',
      (body.sortOrder as number) ?? 0,
      body.metadata ? JSON.stringify(body.metadata) : null
    );
    const row = db.prepare('SELECT * FROM shots WHERE id = ?').get(shotId) as Record<string, unknown>;
    return reply.send(success(parseRow(row)));
  });

  fastify.patch('/api/projects/:id/episodes/:episodeId/shots/:shotId', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { shotId } = req.params as { shotId: string };
    const body = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (['shotIndex', 'shotSeq', 'durationSeconds', 'visualPrompt', 'stylePrompt', 'aspectRatio', 'resolution', 'purposeTag', 'audioType', 'videoStatus', 'status', 'sortOrder', 'sceneId', 'currentMaterialId', 'currentMaterialUrl'].includes(k)) {
        sets.push(`"${k}" = ?`); vals.push(v);
      } else if (k === 'metadata' || k === 'referencedAssets') {
        sets.push(`"${k}" = ?`); vals.push(JSON.stringify(v));
      }
    }
    if (sets.length === 0) return reply.send(success({}));
    sets.push('"updatedAt" = datetime(\'now\')');
    vals.push(shotId);
    db.prepare(`UPDATE shots SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    const row = db.prepare('SELECT * FROM shots WHERE id = ?').get(shotId) as Record<string, unknown>;
    return reply.send(success(parseRow(row)));
  });

  // ---- Assets ----
  fastify.get('/api/projects/:id/assets', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const rows = db.prepare('SELECT * FROM assets WHERE "projectId" = ? ORDER BY kind, name').all(id) as Record<string, unknown>[];
    return reply.send(success(parseRows(rows)));
  });

  fastify.post('/api/projects/:id/assets', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const assetId = randomUUID();
    db.prepare(
      'INSERT INTO assets (id, "projectId", name, kind, "imageUrl", metadata, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))'
    ).run(
      assetId, id, body.name as string, body.kind as string,
      (body.imageUrl as string) ?? null,
      body.metadata ? JSON.stringify(body.metadata) : null
    );
    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as Record<string, unknown>;
    return reply.send(success(parseRow(row)));
  });

  fastify.patch('/api/projects/:id/assets/:assetId', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { assetId } = req.params as { assetId: string };
    const body = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (['name', 'kind', 'imageUrl', 'pencilImageUrl', 'pencilPaintEnabled'].includes(k)) {
        sets.push(`"${k}" = ?`); vals.push(v);
      } else if (k === 'metadata') {
        sets.push(`"${k}" = ?`); vals.push(JSON.stringify(v));
      }
    }
    if (sets.length === 0) return reply.send(success({}));
    sets.push('"updatedAt" = datetime(\'now\')');
    vals.push(assetId);
    db.prepare(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as Record<string, unknown>;
    return reply.send(success(parseRow(row)));
  });

  fastify.delete('/api/projects/:id/assets/:assetId', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { assetId } = req.params as { assetId: string };
    db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
    return reply.send(success({}));
  });

  // ---- Tasks ----
  fastify.get('/api/tasks', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const { status, type } = req.query as { status?: string; type?: string };
    let sql = 'SELECT * FROM tasks WHERE "userId" = ?';
    const params: unknown[] = [userId];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (type) { sql += ' AND type = ?'; params.push(type); }
    sql += ' ORDER BY "updatedAt" DESC LIMIT 100';
    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    return reply.send(success(parseRows(rows)));
  });

  fastify.get('/api/tasks/:taskId', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { taskId } = req.params as { taskId: string };
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send(fail('Task not found', 'NOT_FOUND', 404));
    return reply.send(success(parseRow(row)));
  });

  // ---- Render Jobs ----
  fastify.get('/api/render/jobs/next', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const { machineId } = req.query as { machineId?: string };
    // Atomically claim the next pending job
    const tx = db.transaction(() => {
      const job = db.prepare(
        'SELECT * FROM render_jobs WHERE status = ? AND user_id = ? ORDER BY created_at ASC LIMIT 1'
      ).get('PENDING', userId) as Record<string, unknown> | undefined;
      if (!job) return null;
      const token = randomUUID();
      db.prepare(
        'UPDATE render_jobs SET status = ?, claimed_by = ?, claim_token = ?, claimed_at = datetime(\'now\'), heartbeat_at = datetime(\'now\') WHERE id = ?'
      ).run('RUNNING', machineId ?? 'local', token, job.id);
      return { ...job, status: 'RUNNING', claim_token: token };
    });
    const job = tx();
    if (!job) return reply.send(success(null));
    return reply.send(success(parseRow(job as Record<string, unknown>)));
  });

  fastify.get('/api/render/jobs/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM render_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send(fail('Job not found', 'NOT_FOUND', 404));
    return reply.send(success(parseRow(row)));
  });

  fastify.post('/api/render/jobs/:id/progress', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const body = req.body as { progress?: number; stage?: string; progressClips?: unknown };
    db.prepare(
      'UPDATE render_jobs SET progress = ?, stage = ?, heartbeat_at = datetime(\'now\'), progress_clips = ? WHERE id = ?'
    ).run(body.progress ?? 0, body.stage ?? '', body.progressClips ? JSON.stringify(body.progressClips) : null, id);
    // Publish progress event for SSE
    publishTaskEvent(db, id, 'PROGRESS', { progress: body.progress ?? 0, stage: body.stage ?? '' });
    return reply.send(success({}));
  });

  fastify.post('/api/render/jobs/:id/result', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const body = req.body as { result?: Record<string, unknown> };
    db.prepare(
      'UPDATE render_jobs SET status = ?, result = ?, completed_at = datetime(\'now\'), heartbeat_at = datetime(\'now\') WHERE id = ?'
    ).run('COMPLETED', JSON.stringify(body.result ?? {}), id);
    publishTaskEvent(db, id, 'COMPLETED', { result: body.result ?? {} });
    return reply.send(success({}));
  });

  fastify.post('/api/render/jobs/:id/failed', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const body = req.body as { error?: string };
    db.prepare(
      'UPDATE render_jobs SET status = ?, error = ?, completed_at = datetime(\'now\'), heartbeat_at = datetime(\'now\') WHERE id = ?'
    ).run('FAILED', body.error ?? 'Unknown error', id);
    publishTaskEvent(db, id, 'FAILED', { error: body.error ?? 'Unknown error' });
    return reply.send(success({}));
  });

  // ---- User API Configs (BYOK) ----
  fastify.get('/api/user/api-configs', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const rows = db.prepare('SELECT * FROM api_configs WHERE "userId" = ? ORDER BY "updatedAt" DESC').all(userId) as Record<string, unknown>[];
    const masked = parseRows(rows).map((r) => {
      const key = r.apiKey as string;
      if (key && key.length > 8) r.apiKey = key.slice(0, 8) + '...';
      return r;
    });
    return reply.send(success(masked));
  });

  fastify.post('/api/user/api-configs', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const body = req.body as Record<string, unknown>;
    const id = randomUUID();
    db.prepare(
      'INSERT INTO api_configs (id, "userId", provider, "apiKey", "baseUrl", "isEnabled", label, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))'
    ).run(id, userId, body.provider as string, body.apiKey as string, (body.baseUrl as string) ?? null, 1, (body.label as string) ?? null);
    const row = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(id) as Record<string, unknown>;
    return reply.send(success(parseRow(row)));
  });

  fastify.delete('/api/user/api-configs/:configId', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { configId } = req.params as { configId: string };
    db.prepare('DELETE FROM api_configs WHERE id = ?').run(configId);
    return reply.send(success({}));
  });

  // ---- User Preferences ----
  fastify.get('/api/user/preferences', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const row = db.prepare('SELECT * FROM user_preferences WHERE "userId" = ?').get(userId) as Record<string, unknown> | undefined;
    return reply.send(success(row ? parseRow(row) : { locale: 'zh', theme: 'dark', uiPrefs: {} }));
  });

  fastify.patch('/api/user/preferences', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const body = req.body as Record<string, unknown>;
    const existing = db.prepare('SELECT id FROM user_preferences WHERE "userId" = ?').get(userId);
    if (existing) {
      const sets: string[] = []; const vals: unknown[] = [];
      for (const [k, v] of Object.entries(body)) {
        if (['locale', 'theme'].includes(k)) { sets.push(`"${k}" = ?`); vals.push(v); }
        else if (k === 'uiPrefs') { sets.push(`"${k}" = ?`); vals.push(JSON.stringify(v)); }
      }
      if (sets.length > 0) {
        sets.push('"updatedAt" = datetime(\'now\')'); vals.push(userId);
        db.prepare(`UPDATE user_preferences SET ${sets.join(', ')} WHERE "userId" = ?`).run(...vals);
      }
    } else {
      const id = randomUUID();
      db.prepare(
        'INSERT INTO user_preferences (id, "userId", locale, theme, "uiPrefs", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))'
      ).run(id, userId, (body.locale as string) ?? 'zh', (body.theme as string) ?? 'dark', body.uiPrefs ? JSON.stringify(body.uiPrefs) : null);
    }
    const row = db.prepare('SELECT * FROM user_preferences WHERE "userId" = ?').get(userId) as Record<string, unknown>;
    return reply.send(success(parseRow(row)));
  });

  // ---- Seedance Presets ----
  fastify.get('/api/user/seedance-presets', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const rows = db.prepare('SELECT * FROM seedance_presets WHERE "userId" = ? ORDER BY "createdAt" DESC').all(userId) as Record<string, unknown>[];
    return reply.send(success(parseRows(rows)));
  });

  fastify.post('/api/user/seedance-presets', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const body = req.body as Record<string, unknown>;
    const id = randomUUID();
    db.prepare(
      'INSERT INTO seedance_presets (id, "userId", name, params, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))'
    ).run(id, userId, body.name as string, JSON.stringify(body.params ?? {}));
    const row = db.prepare('SELECT * FROM seedance_presets WHERE id = ?').get(id) as Record<string, unknown>;
    return reply.send(success(parseRow(row)));
  });

  fastify.delete('/api/user/seedance-presets/:presetId', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { presetId } = req.params as { presetId: string };
    db.prepare('DELETE FROM seedance_presets WHERE id = ?').run(presetId);
    return reply.send(success({}));
  });

  // ---- Storage: Presign (local = just return file path) ----
  fastify.post('/api/storage/presign', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const body = req.body as { fileKey?: string; operation?: string };
    // Local mode: return a local file URL
    return reply.send(success({
      url: `sf-asset://${body.fileKey ?? ''}`,
      method: 'PUT',
      headers: {},
    }));
  });

  // ---- Media Relay (serve local files) ----
  fastify.get('/api/media-relay/:token', async (req: FastifyRequest, reply: FastifyReply) => {
    const { token } = req.params as { token: string };
    // token is the storage key
    try {
      const buf = await storage.read(token);
      reply.type('application/octet-stream').send(buf);
    } catch {
      return reply.code(404).send(fail('File not found', 'NOT_FOUND', 404));
    }
  });


  // ---- License ----
  fastify.post('/api/license/activate', async (req: FastifyRequest, reply: FastifyReply) => {
    const { code, machineId } = req.body as { code?: string; machineId?: string };
    if (!code || !machineId) return reply.code(400).send(fail('Missing code or machineId'));
    try {
      const { activateLicense } = await import('@dramaforge/server');
      const result = await activateLicense(code, machineId, dataDir);
      if (!result.success) {
        return reply.code(400).send(fail(result.error ?? 'Activation failed'));
      }
      return reply.send(success({ license: result.license }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send(fail(msg));
    }
  });

  fastify.post('/api/license/deactivate', async (req: FastifyRequest, reply: FastifyReply) => {
    const { deactivateLicense } = await import('@dramaforge/server');
    const result = await deactivateLicense(dataDir, (req.body as { machineId?: string }).machineId ?? '');
    return reply.send(success(result));
  });

  fastify.get('/api/license/status', async (req: FastifyRequest, reply: FastifyReply) => {
    const { getMachineId, getMachineIdShort } = await import('@dramaforge/server');
    const { loadLicense, validateLicense } = await import('@dramaforge/server');
    const machineId = getMachineId();
    const license = await loadLicense(dataDir, machineId);
    if (!license) {
      return reply.send(success({ valid: false, machineId, machineIdShort: getMachineIdShort(), reason: 'NO_LICENSE' }));
    }
    const status = validateLicense(license, machineId, '1.0.0');
    return reply.send(success({ ...status, machineId, machineIdShort: getMachineIdShort() }));
  });

  // ---- Client Heartbeat ----
  fastify.post('/api/client/heartbeat', async (req: FastifyRequest, reply: FastifyReply) => {
    // Just acknowledge — local mode always accepts
    return reply.send(success({ ok: true }));
  });

  // ---- SSE: Task events ----
  fastify.get('/api/sse', async (req: FastifyRequest, reply: FastifyReply) => {
    const taskId = (req.query as { taskId?: string }).taskId;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send existing events
    if (taskId) {
      const events = listEventsAfter(db, taskId, null) as Record<string, unknown>[];
      for (const ev of events) {
        reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
      // Subscribe to new events
      const unsub = onTaskEvent(taskId, (event) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      req.raw.on('close', () => { unsub(); });
    }
  });



  // ---- API Configs (BYOK key management) ----
  fastify.get('/api/api-configs', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    // Local mode: all keys belong to this user (no admin pool)
    const rows = db.prepare(
      'SELECT * FROM api_configs WHERE "userId" = ? ORDER BY provider, "createdAt" ASC'
    ).all(userId) as Record<string, unknown>[];
    // Mask keys in response
    const masked = parseRows(rows).map(r => ({
      ...r,
      apiKey: r.apiKey ? String(r.apiKey).slice(0, 6) + '••••••' + String(r.apiKey).slice(-4) : null,
    }));
    return reply.send(success(masked));
  });

  fastify.post('/api/api-configs', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const body = req.body as Record<string, unknown>;
    const configId = randomUUID();
    db.prepare(
      `INSERT INTO api_configs (id, "userId", provider, "apiKey", "baseUrl", "isEnabled", "keyStatus", name, "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, 1, 'active', ?, datetime('now'), datetime('now'))`
    ).run(
      configId, userId,
      body.provider as string,
      body.apiKey as string,
      (body.baseUrl as string) || null,
      (body.name as string) || null,
    );
    const row = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(configId) as Record<string, unknown>;
    const parsed = parseRow(row)!;
    parsed.apiKey = String(parsed.apiKey).slice(0, 6) + '••••••' + String(parsed.apiKey).slice(-4);
    return reply.send(success(parsed));
  });

  fastify.delete('/api/api-configs/:configId', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { configId } = req.params as { configId: string };
    db.prepare('DELETE FROM api_configs WHERE id = ?').run(configId);
    return reply.send(success({}));
  });

  fastify.patch('/api/api-configs/:configId', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { configId } = req.params as { configId: string };
    const body = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (['provider', 'apiKey', 'baseUrl', 'isEnabled', 'name'].includes(k)) {
        sets.push(`"${k}" = ?`); vals.push(v);
      }
    }
    if (sets.length > 0) {
      sets.push('"updatedAt" = datetime(\'now\')');
      vals.push(configId);
      db.prepare(`UPDATE api_configs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }
    const row = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(configId) as Record<string, unknown>;
    const parsed = parseRow(row)!;
    if (parsed.apiKey) parsed.apiKey = String(parsed.apiKey).slice(0, 6) + '••••••' + String(parsed.apiKey).slice(-4);
    return reply.send(success(parsed));
  });

  fastify.get('/api/api-configs/providers', async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.send(success(getSupportedProviders()));
  });

  // ---- Generate: Video (BYOK — uses user's own API key) ----
  fastify.post('/api/generate/video', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;

    const body = req.body as Record<string, unknown>;
    const modelRaw = body.model;
    if (typeof modelRaw !== 'string' || modelRaw.length === 0) {
      return reply.code(400).send(fail('Missing model field (expected "provider/model-id")', 'MISSING_MODEL'));
    }

    let parsed: { provider: string; model: string };
    try {
      parsed = parseModelId(modelRaw);
    } catch (err) {
      return reply.code(400).send(fail(err instanceof Error ? err.message : 'Bad model format', 'BAD_MODEL'));
    }

    // Strip billing fields (local mode has no billing)
    const input = { ...body };
    delete input.billingTaskId;
    delete input.billingUnitId;
    delete input.model;

    const payload = { capability: 'video_generation' as const, input, userId };

    try {
      const result = await localCallAI(db, userId, parsed.provider, parsed.model, payload);
      return reply.send(success({ url: result.url, meta: result.meta }));
    } catch (err) {
      if (err instanceof LocalGatewayError) {
        const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
        return reply.code(status).send({
          success: false,
          error: `AI generation failed [provider=${err.provider}]: ${err.message}`,
          code: err.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'AI_GATEWAY_ERROR',
          category: 'provider',
          retryable: !err.status || err.status >= 500,
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send(fail(msg, 'INTERNAL_ERROR', 500));
    }
  });

  // ---- Generate: Text (BYOK — uses user's own API key) ----
  fastify.post('/api/generate/text', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;

    const body = req.body as Record<string, unknown>;
    const modelRaw = body.model;
    if (typeof modelRaw !== 'string' || modelRaw.length === 0) {
      return reply.code(400).send(fail('Missing model field', 'MISSING_MODEL'));
    }

    let parsed: { provider: string; model: string };
    try {
      parsed = parseModelId(modelRaw);
    } catch (err) {
      return reply.code(400).send(fail(err instanceof Error ? err.message : 'Bad model format', 'BAD_MODEL'));
    }

    const input = { ...body };
    delete input.model;
    const payload = { capability: 'text_generation' as const, input, userId };

    try {
      const result = await localCallAI(db, userId, parsed.provider, parsed.model, payload);
      return reply.send(success({ url: result.url, meta: result.meta }));
    } catch (err) {
      if (err instanceof LocalGatewayError) {
        const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
        return reply.code(status).send({
          success: false,
          error: `AI generation failed [provider=${err.provider}]: ${err.message}`,
          code: err.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'AI_GATEWAY_ERROR',
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send(fail(msg, 'INTERNAL_ERROR', 500));
    }
  });

  // ---- Generate: Image (BYOK) ----
  fastify.post('/api/generate/image', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;

    const body = req.body as Record<string, unknown>;
    const modelRaw = body.model;
    if (typeof modelRaw !== 'string' || modelRaw.length === 0) {
      return reply.code(400).send(fail('Missing model field', 'MISSING_MODEL'));
    }

    let parsed: { provider: string; model: string };
    try {
      parsed = parseModelId(modelRaw);
    } catch (err) {
      return reply.code(400).send(fail(err instanceof Error ? err.message : 'Bad model format', 'BAD_MODEL'));
    }

    const input = { ...body };
    delete input.model;
    const payload = { capability: 'image_generation' as const, input, userId };

    try {
      const result = await localCallAI(db, userId, parsed.provider, parsed.model, payload);
      return reply.send(success({ url: result.url, meta: result.meta }));
    } catch (err) {
      if (err instanceof LocalGatewayError) {
        const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
        return reply.code(status).send({
          success: false,
          error: `AI generation failed [provider=${err.provider}]: ${err.message}`,
          code: err.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'AI_GATEWAY_ERROR',
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send(fail(msg, 'INTERNAL_ERROR', 500));
    }
  });

  // ---- Films ----
  fastify.get('/api/films', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    // Query completed render_jobs with film output
    const rows = db.prepare(
      'SELECT rj.id, rj.task_id, rj.result, rj.created_at, rj.completed_at FROM render_jobs rj WHERE rj.user_id = ? AND rj.status = ? AND rj.type = ? ORDER BY rj.completed_at DESC LIMIT 50'
    ).all(userId, 'COMPLETED', 'CHAIN_COMPILE') as Record<string, unknown>[];
    return reply.send(success(parseRows(rows)));
  });

  // ---- Catch-all for unimplemented routes ----
  fastify.setNotFoundHandler(async (req: FastifyRequest, reply: FastifyReply) => {
    // For non-API routes, try to serve index.html (SPA fallback)
    if (!req.url.startsWith('/api/')) {
      return reply.code(200).type('text/html').send('<!DOCTYPE html><html><body>Static file not found</body></html>');
    }
    return reply.code(404).send(fail(`Route not implemented: ${req.method} ${req.url}`, 'NOT_IMPLEMENTED', 404));
  });
}