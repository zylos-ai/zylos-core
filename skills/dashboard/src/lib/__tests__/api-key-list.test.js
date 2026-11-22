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
