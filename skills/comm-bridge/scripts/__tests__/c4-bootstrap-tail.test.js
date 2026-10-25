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
    formatConversationsForAgent: selected => selected.map(row => row.content).join('\n') };
  return { calls, scope, db, options: { scopeReader: async () => scope, withDb: async (_label, action) => action(db) } };
}

for (const mode of ['single', 'multi']) test(`P06 2.3: ${mode} tail captures coverage once and preserves messages`, async () => {
  const f = fixture(mode);
  const output = await emitC4Conversations({}, null, f.options);
  assert.deepEqual(f.calls, mode === 'multi'
    ? [['coverage', 'work'], ['tail', 'work', 41, { limit: 6 }]]
    : [['coverage'], ['tail', 41, { limit: 6 }]]);
  assert.match(output, /OLD-ENTIRE-MESSAGE\nLATEST-ENTIRE-MESSAGE/);
  assert.match(output, /read-work-memory\.js/);
  assert.match(output, /handoff\.md/);
  assert.doesNotMatch(output, /CHECKPOINT|Memory Sync/);
});

test('P06 2.3: budget drops whole oldest messages and read failure never changes scope', async () => {
  const f = fixture('multi');
  const unbounded = await emitC4Conversations({}, null, f.options);
  const output = await emitC4Conversations({}, { maxChars: unbounded.length - 10 + 200, maxTokens: 100000 }, f.options);
  assert.doesNotMatch(output, /OLD-ENTIRE-MESSAGE/);
  assert.match(output, /LATEST-ENTIRE-MESSAGE/);
  f.db.getDeliveredSince = () => { throw Object.assign(new Error('busy'), { code: 'DB_BUSY' }); };
  f.db.getGlobalDeliveredSince = () => assert.fail('must not fall back to global');
  await assert.rejects(emitC4Conversations({}, null, f.options), { code: 'DB_BUSY' });
});

test('P06 2.8: only the main session receives validated migration notices', async () => {
  const f = fixture('single');
  for (const [state, pattern] of [['pending', /migration is pending/], ['unreadable', /record UNAVAILABLE/]]) {
    let calls = 0;
    const options = { ...f.options, migrationReader: async () => { calls++; return { state }; } };
    assert.match(await emitC4Conversations({}, null, options), pattern);
    assert.equal(calls, 1);
    assert.doesNotMatch(await emitC4Conversations({ agent_id: 'child' }, null, options), pattern);
    assert.equal(calls, 1);
  }
  const ordinary = fixture('multi');
  await emitC4Conversations({}, null, { ...ordinary.options, migrationReader: () => assert.fail('ordinary group must not inspect W7') });
  assert.doesNotMatch(await emitC4Conversations({}, null, { ...f.options, migrationReader: () => ({ state: 'done' }) }), /migration is pending|record UNAVAILABLE/);
});
