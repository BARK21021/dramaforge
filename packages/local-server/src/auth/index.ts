import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

const JWT_SECRET = process.env.DRAMAFORGE_LOCAL_SECRET || randomUUID();
export const SESSION_COOKIE = 'dramaforge-local-session';
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export interface LocalUser {
  id: string;
  email: string | null;
  phone: string | null;
  name: string;
  role: string;
  credits: number;
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export function createToken(userId: string): string {
  return jwt.sign({ sub: userId, stamp: Date.now() }, JWT_SECRET, { expiresIn: SESSION_MAX_AGE });
}

export function verifyToken(token: string): { sub: string } | null {
  try {
    const p = jwt.verify(token, JWT_SECRET) as { sub?: string };
    return p.sub ? { sub: p.sub } : null;
  } catch { return null; }
}

export function registerUser(db: Database, username: string, password: string) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ? OR name = ?').get(username, username);
  if (existing) throw new Error('USERNAME_TAKEN');
  const id = randomUUID();
  const hash = hashPassword(password);
  db.prepare(
    'INSERT INTO users (id, email, name, "passwordHash", role, credits, provider, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))'
  ).run(id, username, username, hash, 'ADMIN', 999999, 'CREDENTIALS');
  const token = createToken(id);
  const user: LocalUser = { id, email: username, phone: null, name: username, role: 'ADMIN', credits: 999999 };
  return { user, token };
}

export function loginUser(db: Database, username: string, password: string) {
  const row = db.prepare('SELECT * FROM users WHERE email = ? OR name = ?').get(username, username) as Record<string, unknown> | undefined;
  if (!row) throw new Error('USER_NOT_FOUND');
  const hash = row.passwordHash as string;
  if (!hash || !verifyPassword(password, hash)) throw new Error('WRONG_PASSWORD');
  db.prepare('UPDATE users SET "lastLoginAt" = datetime(\'now\'), "updatedAt" = datetime(\'now\') WHERE id = ?').run(row.id);
  const token = createToken(row.id as string);
  const user: LocalUser = {
    id: row.id as string, email: (row.email as string) ?? null, phone: (row.phone as string) ?? null,
    name: (row.name as string) ?? username, role: (row.role as string) ?? 'ADMIN', credits: (row.credits as number) ?? 999999,
  };
  return { user, token };
}

export function getUserById(db: Database, userId: string): LocalUser | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string, email: (row.email as string) ?? null, phone: (row.phone as string) ?? null,
    name: (row.name as string) ?? '', role: (row.role as string) ?? 'ADMIN', credits: (row.credits as number) ?? 0,
  };
}