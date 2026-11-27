import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emitC4Conversations } from '../c4-session-init.js';

function fixture(mode) {
  const calls = [];
  const scope = { mode, scope: mode === 'multi' ? 'work' : '*', sessionGroup: mode === 'multi' ? 'work' : null,
    root: process.env.ZYLOS_DIR, memoryDir: `${process.env.ZYLOS_DIR}/memory` };
  const rows = [{ id: 42, content: 'OLD-ENTIRE-MESSAGE' }, { id: 43, content: 'LATEST-ENTIRE-MESSAGE' }];
  const db = { getRecentDeliveredConversations: (...args) => { calls.push(args); return { rows, older: null }; },
    formatConversationsForAgent: selected => selected.map(row => row.content).join('\n') };
  return { calls, scope, db, options: { scopeReader: async () => scope, withDb: async (_label, action) => action(db) } };
}

test('budget drops whole oldest messages and read failure never changes scope', async () => {
  const f = fixture('multi');
  const unbounded = await emitC4Conversations({}, null, f.options);
  const output = await emitC4Conversations({}, { maxChars: unbounded.length - 10 + 200, maxTokens: 100000 }, f.options);
  assert.doesNotMatch(output, /OLD-ENTIRE-MESSAGE/);
  assert.match(output, /LATEST-ENTIRE-MESSAGE/);
  assert.deepEqual(f.calls, Array(2).fill(['work', { afterTimestamp: undefined, limit: 6 }]));
  f.db.getRecentDeliveredConversations = group => {
    assert.equal(group, 'work', 'must not fall back to global');
    throw Object.assign(new Error('busy'), { code: 'DB_BUSY' });
  };
  await assert.rejects(emitC4Conversations({}, null, f.options), { code: 'DB_BUSY' });
});
