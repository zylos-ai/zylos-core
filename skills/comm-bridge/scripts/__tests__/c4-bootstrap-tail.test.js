import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emitC4Conversations, readStartupConversationTail } from '../c4-session-init.js';
import path from 'node:path';

// Official runner-owned environment; mocked C4 API only, no DB/HTTP/PM2/tmux.
const runnerRoot = path.dirname(process.env.HOME);
assert.match(path.basename(runnerRoot), /^zylos-tests-/);
for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.ok(process.env[key]?.startsWith(runnerRoot + path.sep), key);
console.info('startup tail isolation', JSON.stringify(Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]))));

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

test('recovery gate runs before scope resolution even through the direct export', async () => {
  let gateCalls = 0;
  const output = await emitC4Conversations({}, null, {
    scopeReader: () => assert.fail('blocked recovery must not resolve scope'),
    withDb: async () => { gateCalls++; return 'SYSTEM RECOVERY TASK'; },
  });
  assert.equal(gateCalls, 1);
  assert.equal(output, 'SYSTEM RECOVERY TASK');
});

for (const mode of ['single', 'multi']) test(`${mode} tail captures coverage once and preserves messages`, async () => {
  const f = fixture(mode);
  const output = await emitC4Conversations({}, null, f.options);
  assert.deepEqual(f.calls, mode === 'multi'
    ? [['coverage', 'work'], ['tail', 'work', 41, { limit: 6 }], ['range', 'work']]
    : [['coverage'], ['tail', 41, { limit: 6 }], ['range']]);
  assert.match(output, /OLD-ENTIRE-MESSAGE\nLATEST-ENTIRE-MESSAGE/);
  assert.match(output, /read-work-memory\.js/);
  assert.match(output, /handoff\.md/);
  assert.doesNotMatch(output, /CHECKPOINT|Memory Sync/);
});

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

test('only the main session receives validated migration notices', async () => {
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

for (const mode of ['single', 'multi']) {
  function backlogFixture(count = 300) {
    const f = fixture(mode);
    const rows = Array.from({ length: Math.min(6, count) }, (_, i) => ({ id: 42 + count - Math.min(6, count) + i, content: `TAIL_${i}_${'x'.repeat(300)}` }));
    f.db.getDeliveredSince = f.db.getGlobalDeliveredSince = () => rows;
    f.db.getUnsummarizedRange = f.db.getGlobalUnsummarizedRange = () => ({ count, firstConversationId: 42 });
    return { ...f, rows };
  }
  test(`${mode} omitted backlog notice gives coverage, actual tail count and scoped paging command`, async () => {
    const f = backlogFixture();
    const out = await emitC4Conversations({ agent_id: 'child' }, null, f.options);
    assert.match(out, /Checkpoint covers id 41/);
    assert.match(out, /state.md may lag \(use its header coverage\)/);
    assert.match(out, /About 300 messages unsummarized; latest 6 shown/);
    assert.ok(out.includes(`node ${f.scope.root}/.claude/skills/comm-bridge/scripts/c4-fetch.js --unsummarized${mode === 'multi' ? ' --group work' : ''} --limit 50`));
    assert.match(out, /--after <previous output's round upper bound>/);
    assert.match(out, /old tasks, promises or todos/);
    assert.match(out, /oldest shown id 336; reads stop at the delivered frontier/);
    for (const row of f.rows) assert.ok(out.includes(row.content));
  });
  test(`${mode} complete four-message tail has no lag notice`, async () => {
    const f = backlogFixture(4);
    assert.doesNotMatch(await emitC4Conversations({ agent_id: 'child' }, null, f.options), /unsummarized|--after/);
  });
  test(`${mode} exact full-tail budget keeps all four messages without manufacturing a gap`, async () => {
    const f = backlogFixture(4);
    const full = await emitC4Conversations({ agent_id: 'child' }, null, f.options);
    const out = await emitC4Conversations({ agent_id: 'child' }, { maxChars: full.length + 200, maxTokens: 100000 }, f.options);
    assert.equal(out, full);
    assert.doesNotMatch(out, /unsummarized|--after/);
    for (const row of f.rows) assert.ok(out.includes(row.content));
  });
  test(`${mode} unavailable backlog count preserves the complete tail`, async () => {
    const f = backlogFixture();
    f.db.getUnsummarizedRange = f.db.getGlobalUnsummarizedRange = () => { throw Error('busy'); };
    const out = await emitC4Conversations({ agent_id: 'child' }, null, f.options);
    assert.match(out, /Unsummarized count temporarily unavailable/);
    for (const row of f.rows) assert.ok(out.includes(row.content));
    assert.doesNotMatch(out, /--unsummarized|About 300/);
  });
  test(`${mode} budget preserves the complete lag notice while trimming to two messages`, async () => {
    const f = backlogFixture();
    const all = await emitC4Conversations({ agent_id: 'child' }, null, f.options);
    const removedLength = f.rows.slice(0, 4).reduce((n, row) => n + row.content.length + 1, 0);
    const maxChars = all.length - removedLength + 200;
    const out = await emitC4Conversations({ agent_id: 'child' }, { maxChars, maxTokens: 100000 }, f.options);
    assert.match(out, /About 300 messages unsummarized; latest 2 shown/);
    assert.match(out, /oldest shown id 340; reads stop at the delivered frontier\./);
    assert.ok(out.length <= maxChars);
    for (const row of f.rows.slice(0, 4)) assert.ok(!out.includes(row.content));
    for (const row of f.rows.slice(4)) assert.ok(out.includes(row.content));
  });
  test(`${mode} empty visible tail still explains omitted unsummarized messages`, async () => {
    const f = backlogFixture();
    f.db.getDeliveredSince = f.db.getGlobalDeliveredSince = () => [];
    assert.match(await emitC4Conversations({ agent_id: 'child' }, null, f.options), /About 300 messages unsummarized; latest 0 shown/);
  });
}


for (const sessionGroup of [null, 'origin', 'telegram:one']) {
  test(`startup decision reuses the context tail read in ${sessionGroup ?? 'single global'} scope`, async () => {
    const f = fixture(sessionGroup ? 'multi' : 'single');
    const scope = { ...f.scope, sessionGroup, scope: sessionGroup ?? '*' };
    const result = await readStartupConversationTail(scope, {
      withDb: async (_label, read) => read(f.db),
    });
    assert.equal(result.coverage, 41);
    assert.equal(result.conversations.length, 2);
    assert.deepEqual(f.calls, sessionGroup
      ? [['coverage', sessionGroup], ['tail', sessionGroup, 41, { limit: 6 }]]
      : [['coverage'], ['tail', 41, { limit: 6 }]]);
    assert.equal(result.conversations[1].content, 'LATEST-ENTIRE-MESSAGE');
  });
}

test('startup tail failure propagates without querying another scope', async () => {
  const f = fixture('multi');
  f.db.getDeliveredSince = () => { throw Error('fixture C4 unavailable'); };
  f.db.getGlobalDeliveredSince = () => assert.fail('must not fall back to global');
  await assert.rejects(readStartupConversationTail(f.scope, {
    withDb: async (_label, read) => read(f.db),
  }), /fixture C4 unavailable/);
});
