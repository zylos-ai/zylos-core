import test from 'node:test';
import assert from 'node:assert/strict';
import { apiKeysPage } from '../api-key-list.js';

test('an unreadable key table is 503 unavailable, and a refused query reads nothing', () => {
  const broken = { listApiKeysPage: () => { throw new Error('database is locked'); }, countApiKeys: () => ({ active: 0, revoked: 0, matched: 0 }) };
  assert.throws(() => apiKeysPage(broken, new URLSearchParams('limit=8')), error => error.statusCode === 503 && error.code === 'unavailable');
  let reads = 0;
  const counted = { listApiKeysPage: () => { reads++; return []; }, countApiKeys: () => { reads++; return { active: 0, revoked: 0, matched: 0 }; } };
  assert.throws(() => apiKeysPage(counted, new URLSearchParams('limit=8&limit=9')), error => error.code === 'invalid_parameter' && error.param === 'limit');
  assert.equal(reads, 0);
});

test('key rows carry metadata only, and counts cover every key whatever the search', () => {
  const row = { id: 3, name: 'ci', scope: 'read', key_hash: 'secret', created_at: '2026-11-01 00:00:00', last_used_at: null, revoked_at: null, revoked: 0 };
  const store = { listApiKeysPage: () => [row], countApiKeys: () => ({ active: 4, revoked: 2, matched: 1 }) };
  const page = apiKeysPage(store, new URLSearchParams('q=ci&include=total'));
  assert.deepEqual(page, { items: [{ name: 'ci', scope: 'read', created_at: '2026-11-01 00:00:00', last_used_at: null, revoked_at: null, status: 'active' }],
    nextCursor: null, total: 1, counts: { active: 4, revoked: 2 } });
});
