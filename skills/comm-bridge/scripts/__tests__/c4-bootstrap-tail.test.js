import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emitC4Conversations } from '../c4-session-init.js';

function fixture(mode) {
  const calls = [];
  let coverage = 41;
  const scope = { mode, scope: mode === 'multi' ? 'work' : '*', sessionGroup: mode === 'multi' ? 'work' : null,
    root: process.env.ZYLOS_DIR, memoryDir: `${process.env.ZYLOS_DIR}/memory` };
  const rows = [{ id: 42, content: 'OLD-ENTIRE-MESSAGE' }, { id: 43, content: 'LATEST-ENTIRE-MESSAGE' }];
  const readCoverage = (...args) => { calls.push(['coverage', ...args]); const result = coverage; coverage++; return result; };
  const readTail = (...args) => { calls.push(['tail', ...args]); return rows; };
  const db = { getCoverageEnd: readCoverage, getGlobalCoverageEnd: readCoverage,
    getDeliveredSince: readTail, getGlobalDeliveredSince: readTail,
    getUnsummarizedRange: (...args) => { calls.push(['range', ...args]); return { count: 0, firstConversationId: null }; },
    getGlobalUnsummarizedRange: (...args) => { calls.push(['range', ...args]); return { count: 0, firstConversationId: null }; },
    formatConversationsForAgent: selected => selected.map(row => row.content).join('\n') };
  return { calls, scope, db, options: { scopeReader: async () => scope, withDb: async (_label, action) => action(db) } };
}

test('budget drops whole oldest messages and read failure never changes scope', async () => {
  const f = fixture('multi');
  const unbounded = await emitC4Conversations({}, null, f.options);
  const output = await emitC4Conversations({}, { maxChars: unbounded.length - 10 + 200, maxTokens: 100000 }, f.options);
  assert.doesNotMatch(output, /OLD-ENTIRE-MESSAGE/);
  assert.match(output, /LATEST-ENTIRE-MESSAGE/);
  f.db.getDeliveredSince = () => { throw Object.assign(new Error('busy'), { code: 'DB_BUSY' }); };
  f.db.getGlobalDeliveredSince = () => assert.fail('must not fall back to global');
  await assert.rejects(emitC4Conversations({}, null, f.options), { code: 'DB_BUSY' });
});
