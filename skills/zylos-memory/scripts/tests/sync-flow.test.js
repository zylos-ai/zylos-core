import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkingSync } from './fx-sync.js';
const order = ['acquire', 'range', 'fetch', 'cleanup', 'rotate', 'readMemory', 'differences', 'prepare', 'checkpoint', 'editMemory', 'commit', 'release'];
function commands({ fail, code = 'IO_ERROR', count = 18, releaseFails = false, identityChanged = false } = {}) {
  const calls = [];
  return { calls, call: async (name, args) => {
    calls.push({ name, args });
    if (name === fail || (name === 'release' && releaseFails)) throw Object.assign(new Error(name), { code });
    if (name === 'acquire') return '0123456789abcdef0123456789abcdef';
    if (name === 'range') return { count, safeEnd: 300 };
    if (name === 'fetch') return { end: 251, rows: [] };
    if (name === 'readMemory') return { coverage: null };
    if (name === 'prepare') return { summary: 'summary including inbox', state: 'new state', followedUpIds: [2], identityChanged };
  } };
}
test('IF42 FX-SYNC: success follows checkpoint then restricted edit then commit; unknown coverage starts at zero', async () => {
  const f = commands(); const result = await runWorkingSync(f.call);
  assert.deepEqual(result.log, order);
  assert.equal(f.calls.find(c => c.name === 'differences').args.after, 0);
  assert.equal(f.calls.find(c => c.name === 'checkpoint').args.end, 251);
  assert.deepEqual(f.calls.find(c => c.name === 'commit').args.followedUpIds, [2]);
});
test('IF42 FX-SYNC: empty range releases without cleanup or consuming inbox', async () => {
  const result = await runWorkingSync(commands({ count: 0 }).call);
  assert.equal(result.outcome, 'empty');
  assert.deepEqual(result.log, ['acquire', 'range', 'release']);
});
test('IF42 FX-SYNC: only SYNC_BUSY acquisition is normal; no acquired token means no release', async () => {
  for (const code of ['SYNC_BUSY', 'LOCK_TIMEOUT', 'IO_ERROR']) {
    const result = await runWorkingSync(commands({ fail: 'acquire', code }).call);
    assert.equal(result.outcome, code === 'SYNC_BUSY' ? 'busy' : 'failed');
    assert.deepEqual(result.log, ['acquire']);
  }
});
test('IF42 FX-SYNC: every necessary operation stops subsequent writes and releases once for non-takeover failure', async () => {
  for (const fail of order.slice(1, -1)) {
    const result = await runWorkingSync(commands({ fail }).call);
    assert.equal(result.outcome, 'failed', fail);
    assert.deepEqual(result.log, [...order.slice(0, order.indexOf(fail) + 1), 'release'], fail);
  }
});
test('IF42 FX-SYNC: takeover at any step stops immediately including release', async () => {
  for (const fail of order.slice(1, -1)) {
    const result = await runWorkingSync(commands({ fail, code: 'TOKEN_MISMATCH' }).call);
    assert.equal(result.outcome, 'takenOver');
    assert.deepEqual(result.log, order.slice(0, order.indexOf(fail) + 1));
  }
});
test('IF42 FX-SYNC: release failure is an additional warning and never retried', async () => {
  for (const fail of [undefined, 'checkpoint']) {
    const result = await runWorkingSync(commands({ fail, releaseFails: true }).call);
    assert.equal(result.outcome, fail ? 'failed' : 'success');
    assert.equal(result.log.filter(name => name === 'release').length, 1);
    assert.equal(result.warnings.length, fail ? 2 : 1);
  }
});
test('P07 global FX-SYNC: necessary self write failure blocks checkpoint; rotation failure does not', async () => {
  const self = await runWorkingSync(commands({ fail: 'selfWrite' }).call, { kind: 'global' });
  assert.equal(self.outcome, 'failed');
  assert.ok(!self.log.includes('checkpoint'));
  for (const code of ['TRANSITION_OPEN', 'DB_WRITE_FAILED']) {
    const rotation = await runWorkingSync(commands({ fail: 'requestRotation', code, identityChanged: true }).call, { kind: 'global' });
    assert.equal(rotation.outcome, 'success');
    assert.equal(rotation.warnings[0].code, code);
    assert.deepEqual(rotation.log.slice(-4), ['checkpoint', 'editMemory', 'commit', 'release']);
  }
});

import { runOriginSync } from './fx-sync.js';
function originCommands(fail, code = 'READ_FAILED') {
  return async (name, args) => {
    if (`${name}:${args.group ?? ''}` === fail) throw Object.assign(new Error(fail), { code });
    if (name === 'acquire') return 'token';
    if (name === 'backlog') return [
      { sessionGroup: 'sleeping', cursorUpdatedAt: 1, cursorFrom: 0, upTo: 100 },
      { sessionGroup: 'late-summary', cursorUpdatedAt: 2, cursorFrom: 10, upTo: 200 },
      { sessionGroup: 'no-summary', cursorUpdatedAt: 3, cursorFrom: 5, upTo: 300 },
    ];
    if (name === 'summaries') return args.group === 'late-summary' ? { coverageEnd: 150, checkpointId: 7, summaries: ['late summary'] } : { coverageEnd: 0, checkpointId: 0, summaries: [] };
    if (name === 'raw') return { rows: Array.from({ length: args.limit }, (_,i) => ({ id: i * 2 + 1 })), truncated: true };
    if (name === 'selfWrite') return { identityChanged: args.group === 'late-summary' };
  };
}
test('P07 Origin FX-SYNC: sleeping group spends 50 raw rows; late summary advances after budget exhausted', async () => {
  const result = await runOriginSync(originCommands());
  assert.equal(result.remaining, 0);
  assert.deepEqual(result.log.filter(x => x.name === 'raw').map(({ group, after, limit }) => ({ group, after, limit })), [{ group: 'sleeping', after: 0, limit: 50 }]);
  assert.deepEqual(result.log.filter(x => x.name === 'advance').map(({ group, synced, checkpoint }) => ({ group, synced, checkpoint })), [
    { group: 'sleeping', synced: 99, checkpoint: 0 }, { group: 'late-summary', synced: 150, checkpoint: 7 },
  ]);
  assert.equal(result.log.filter(x => x.name === 'summaries').length, 3);
});
test('P07 Origin FX-SYNC: failed group makes no progress; other groups continue and release once', async () => {
  for (const operation of ['summaries', 'raw', 'sessions', 'selfWrite']) {
    const result = await runOriginSync(originCommands(`${operation}:sleeping`));
    assert.ok(!result.log.some(x => x.name === 'advance' && x.group === 'sleeping'));
    assert.ok(result.log.some(x => x.name === 'advance' && x.group === 'late-summary'));
    assert.equal(result.log.filter(x => x.name === 'release').length, 1);
  }
});
test('P07 Origin FX-SYNC: first snapshot coverage and checkpoint survive a later publication', async () => {
  const original = originCommands(); let publication = false;
  const result = await runOriginSync(async (name, args) => {
    if (name === 'summaries' && args.group === 'sleeping') return { coverageEnd: publication ? 80 : 20, checkpointId: publication ? 9 : 2, summaries: ['first'] };
    if (name === 'raw' && args.group === 'sleeping') { publication = true; assert.equal(args.after, 20); }
    return original(name, args);
  });
  assert.equal(result.log.find(x => x.name === 'advance' && x.group === 'sleeping').checkpoint, 2);
});
test('P07 Origin FX-SYNC: takeover halts all future steps; identity rotation failure preserves cursor progression', async () => {
  const taken = await runOriginSync(originCommands('selfWrite:sleeping', 'TOKEN_MISMATCH'));
  assert.equal(taken.outcome, 'takenOver');
  assert.equal(taken.log.at(-1).name, 'selfWrite');
  for (const code of ['TRANSITION_OPEN', 'DB_WRITE_FAILED']) {
    const result = await runOriginSync(originCommands('requestRotation:', code));
    assert.equal(result.log.filter(x => x.name === 'advance').length, 2);
    assert.equal(result.log.at(-1).name, 'release');
    assert.equal(result.failures[0].error.code, code);
  }
});
