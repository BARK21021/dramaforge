import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadEnv, _resetEnvCacheForTests } from '../../src/infra/env';

/** 完整合法的环境变量集合 */
const FULL_ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://user:pass@host:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  MINIO_ENDPOINT: 'http://localhost:9000',
  MINIO_ACCESS_KEY: 'access-key',
  MINIO_SECRET_KEY: 'secret-key',
  MINIO_BUCKET: 'dramaforge',
  NEXTAUTH_SECRET: 'super-secret',
  NEXTAUTH_URL: 'http://localhost:3000',
};

describe('loadEnv', () => {
  /** 保存原始 env 值，测试后恢复 */
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    _resetEnvCacheForTests();
    for (const k of Object.keys(FULL_ENV)) saved[k] = process.env[k];
  });

  afterEach(() => {
    _resetEnvCacheForTests();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('parses when all required fields are present', () => {
    for (const [k, v] of Object.entries(FULL_ENV)) process.env[k] = v;
    const e = loadEnv();
    expect(e.DATABASE_URL).toBe(FULL_ENV.DATABASE_URL);
    expect(e.REDIS_URL).toBe(FULL_ENV.REDIS_URL);
    expect(e.MINIO_ENDPOINT).toBe(FULL_ENV.MINIO_ENDPOINT);
    expect(e.MINIO_ACCESS_KEY).toBe(FULL_ENV.MINIO_ACCESS_KEY);
    expect(e.MINIO_SECRET_KEY).toBe(FULL_ENV.MINIO_SECRET_KEY);
    expect(e.MINIO_BUCKET).toBe(FULL_ENV.MINIO_BUCKET);
    expect(e.NEXTAUTH_SECRET).toBe(FULL_ENV.NEXTAUTH_SECRET);
    expect(e.NEXTAUTH_URL).toBe(FULL_ENV.NEXTAUTH_URL);
  });

  it('throws when a required field is missing', () => {
    for (const [k, v] of Object.entries(FULL_ENV)) process.env[k] = v;
    delete process.env.DATABASE_URL;
    expect(() => loadEnv()).toThrow();
  });

  it('throws when a required field is an empty string', () => {
    for (const [k, v] of Object.entries(FULL_ENV)) process.env[k] = v;
    process.env.REDIS_URL = '';
    expect(() => loadEnv()).toThrow();
  });

  it('error message mentions the failing field', () => {
    for (const [k, v] of Object.entries(FULL_ENV)) process.env[k] = v;
    delete process.env.MINIO_BUCKET;
    try {
      loadEnv();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('MINIO_BUCKET');
    }
  });

  it('MINIO_PUBLIC_BASE_URL is optional (omitted is OK)', () => {
    for (const [k, v] of Object.entries(FULL_ENV)) process.env[k] = v;
    delete process.env.MINIO_PUBLIC_BASE_URL;
    const e = loadEnv();
    expect(e.MINIO_PUBLIC_BASE_URL).toBeUndefined();
  });

  it('MINIO_PUBLIC_BASE_URL accepts a valid URL when provided', () => {
    for (const [k, v] of Object.entries(FULL_ENV)) process.env[k] = v;
    process.env.MINIO_PUBLIC_BASE_URL = 'https://minio.example.com';
    const e = loadEnv();
    expect(e.MINIO_PUBLIC_BASE_URL).toBe('https://minio.example.com');
  });

  it('MINIO_PUBLIC_BASE_URL rejects a non-URL value', () => {
    for (const [k, v] of Object.entries(FULL_ENV)) process.env[k] = v;
    process.env.MINIO_PUBLIC_BASE_URL = 'not-a-url';
    expect(() => loadEnv()).toThrow();
  });
});
