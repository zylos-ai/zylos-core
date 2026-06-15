import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { openDb, SessionStore, PersistentUploadRegistry } from '../skills/web-console/scripts/db.js';

let tempDir;
let db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-db-test-'));
  db = openDb(path.join(tempDir, 'test.db'));
});

afterEach(() => {
  if (db) db.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('SessionStore', () => {
  test('creates, checks, touches, and deletes sessions', () => {
    const store = new SessionStore(db);
    const token = store.create();

    expect(typeof token).toBe('string');
    expect(token.length).toBe(64);
    expect(store.has(token)).toBe(true);
    expect(store.has('nonexistent')).toBe(false);

    store.touch(token);
    expect(store.has(token)).toBe(true);

    store.delete(token);
    expect(store.has(token)).toBe(false);
  });

  test('persists sessions across store instances', () => {
    const store1 = new SessionStore(db);
    const token = store1.create();
    expect(store1.has(token)).toBe(true);

    const store2 = new SessionStore(db);
    expect(store2.has(token)).toBe(true);
  });

  test('cleans up expired sessions', () => {
    const store = new SessionStore(db, { maxAgeMs: 100 });
    const token = store.create();
    expect(store.has(token)).toBe(true);

    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?')
      .run(Date.now() - 200, token);

    store.cleanup();
    expect(store.has(token)).toBe(false);
  });

  test('maxAgeSec returns seconds', () => {
    const store = new SessionStore(db, { maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
    expect(store.maxAgeSec).toBe(604800);
  });
});

describe('PersistentUploadRegistry', () => {
  test('add, getMany, consumeMany work like in-memory registry', () => {
    const registry = new PersistentUploadRegistry(db, { ttlMs: 30000 });
    const entry = registry.add({
      sessionId: 's1',
      path: '/tmp/a.txt',
      name: 'a.txt',
      size: 100,
      sizeLabel: '100B',
      mime: 'text/plain',
      kind: 'file'
    });

    expect(entry.id).toBeDefined();
    expect(registry.getMany([entry.id], 's1')).toHaveLength(1);
    expect(registry.getMany([entry.id], 's2')).toHaveLength(0);
    expect(registry.getMany([entry.id, entry.id], 's1')).toHaveLength(0);

    const consumed = registry.consumeMany([entry.id], 's1');
    expect(consumed).toHaveLength(1);
    expect(consumed[0].path).toBe('/tmp/a.txt');

    expect(registry.consumeMany([entry.id], 's1')).toBeNull();
  });

  test('restoreMany re-enables consumed entries', () => {
    const registry = new PersistentUploadRegistry(db, { ttlMs: 30000 });
    const entry = registry.add({ sessionId: 's1', path: '/tmp/b.txt', name: 'b.txt', size: 50, kind: 'file' });
    const consumed = registry.consumeMany([entry.id], 's1');

    expect(registry.consumeMany([entry.id], 's1')).toBeNull();
    registry.restoreMany(consumed);
    expect(registry.getMany([entry.id], 's1')).toHaveLength(1);
  });

  test('expired entries are cleaned up', () => {
    const registry = new PersistentUploadRegistry(db, { ttlMs: 100 });
    const entry = registry.add({ sessionId: 's1', path: '/tmp/c.txt', name: 'c.txt', size: 10, kind: 'file' });

    db.prepare('UPDATE uploads SET created_at = ? WHERE id = ?')
      .run(Date.now() - 200, entry.id);

    expect(registry.consumeMany([entry.id], 's1')).toBeNull();
  });

  test('persists uploads across registry instances', () => {
    const reg1 = new PersistentUploadRegistry(db, { ttlMs: 30000 });
    const entry = reg1.add({ sessionId: 's1', path: '/tmp/d.txt', name: 'd.txt', size: 5, kind: 'file' });

    const reg2 = new PersistentUploadRegistry(db, { ttlMs: 30000 });
    expect(reg2.getMany([entry.id], 's1')).toHaveLength(1);
  });
});
