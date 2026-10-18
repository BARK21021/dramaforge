import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertIsolatedE2eBucket,
  assertIsolatedE2eDatabaseUrl,
  assertLocalDatabaseUrl,
} from './env.js';

describe('assertLocalDatabaseUrl', () => {
  it('accepts explicit loopback PostgreSQL authorities', () => {
    assert.doesNotThrow(() =>
      assertLocalDatabaseUrl('postgresql://user:pass@localhost:5432/dramaforge'),
    );
    assert.doesNotThrow(() =>
      assertLocalDatabaseUrl('postgres://user:pass@127.0.0.1:5432/dramaforge'),
    );
    assert.doesNotThrow(() =>
      assertLocalDatabaseUrl('postgresql://user:pass@[::1]:5432/dramaforge'),
    );
  });

  it('rejects a remote authority', () => {
    assert.throws(
      () => assertLocalDatabaseUrl('postgresql://user:pass@db.example.com/dramaforge'),
      /non-local database host/,
    );
  });

  it('rejects query parameters that can override a loopback authority', () => {
    for (const query of [
      'host=db.example.com',
      'HOST=db.example.com',
      '%68ost=db.example.com',
      'hostaddr=203.0.113.10',
    ]) {
      assert.throws(
        () => assertLocalDatabaseUrl(`postgresql://user:pass@localhost/dramaforge?${query}`),
        /may override its host/,
      );
    }
  });
});

describe('isolated E2E targets', () => {
  it('requires a loopback database whose name ends in _e2e', () => {
    assert.doesNotThrow(() =>
      assertIsolatedE2eDatabaseUrl('postgresql://user:pass@localhost/dramaforge_e2e'),
    );
    assert.throws(
      () => assertIsolatedE2eDatabaseUrl('postgresql://user:pass@localhost/dramaforge'),
      /must end with _e2e/,
    );
  });

  it('requires a dedicated -e2e bucket', () => {
    assert.doesNotThrow(() => assertIsolatedE2eBucket('dramaforge-e2e'));
    assert.throws(() => assertIsolatedE2eBucket('dramaforge'), /must end with -e2e/);
  });
});
