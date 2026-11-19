import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture } from './helpers/router-fixture.js';
import { createSinglePreparation, createLegacyMigration } from '../router/resident.js';

test('single preparation cleans lifecycle state and builds instructions in order', async () => {
  const calls = [];
  const prepare = createSinglePreparation({
    clearStaleState: async runtime => calls.push(['clear',runtime]),
    resetToolLifecycle: async runtime => calls.push(['reset',runtime]),
    buildInstructionFile: async runtime => calls.push(['instructions',runtime]),
  });
  await prepare('codex');
  assert.deepEqual(calls, [['clear','codex'],['reset','codex'],['instructions','codex']]);
});

test('legacy waits idle, sends exit once, confirms disappearance; busy target forced at 300s by observed runtime', async () => {
  let now = 0; const live = new Map([['claude-main',{ present:true,tmuxName:'claude-main',runtime:'claude',runId:null }],
    ['codex-main',{ present:true,tmuxName:'codex-main',runtime:'codex',runId:'old' }]]);
  const calls = [];
  const migration = createLegacyMigration({ now: () => now, readLegacy: async name => live.get(name) ?? {present:false},
    readLegacyStatus: async name => ({state:name==='claude-main'?'idle':'busy', idle_seconds:4}),
    sendExit: async target => calls.push(['exit',target.tmuxName]), session: {stop: async input => { calls.push(['stop',input]); live.delete(input.tmuxName); }},
    diagnostic: (event, fields) => calls.push([event,fields]) });
  const entries = await migration.findLegacySessions(); await migration.advanceLegacy(entries); await migration.advanceLegacy(entries);
  assert.deepEqual(calls.filter(x => x[0]==='exit'), [['exit','claude-main']]);
  live.delete('claude-main'); await migration.advanceLegacy(entries);
  now = 299999; await migration.advanceLegacy(entries);
  assert.equal(calls.some(x => x[0] === 'stop'), false);
  now = 300000; await migration.advanceLegacy(entries);
  assert.deepEqual(calls.find(x => x[0]==='stop'), ['stop', {tmuxName:'codex-main',expectedRunId:'old'}]);
  assert.deepEqual(calls.filter(x => x[0]==='legacy_tmux_stopped').map(x => x[1].reason), ['exited','forced']);
});

test('unknown legacy runtime never guesses adapter; failed stop remains pending', async () => {
  let now = 0, runtime = 'unknown', stopCount = 0;
  const migration = createLegacyMigration({ now:()=>now, readLegacy:async name => ({present:name==='claude-main',runtime,tmuxName:name,runId:null}),
    readLegacyStatus:async()=>({state:'busy'}),sendExit:async()=>assert.fail('busy'),session: {stop:async()=>{stopCount++;throw Error('unconfirmed');}} });
  const entries=await migration.findLegacySessions(); now=300001; await migration.advanceLegacy(entries); assert.equal(stopCount,0);
  runtime='claude';await migration.advanceLegacy(entries); assert.equal(stopCount,1);assert.equal(entries[0].stopped,false);
});

for (const runtime of ['claude', 'codex']) {
  test(`${runtime} legacy exit gets sixty seconds from successful submission`, async () => {
    let now = 0, stops = 0;
    const events = [];
    const migration = createLegacyMigration({ now: () => now,
      readLegacy: async name => ({ present: name === 'claude-main', tmuxName: name, runtime, runId: null }),
      readLegacyStatus: async () => ({ state: 'idle', idle_seconds: 3 }),
      sendExit: async () => { now += 50; },
      session: { stop: async () => { stops++; } },
      diagnostic: (event, fields) => events.push({ event, ...fields }),
    });
    const entries = await migration.findLegacySessions();
    now = 10000; await migration.advanceLegacy(entries);
    assert.equal(entries[0].exitSentAt, 10050);
    now = 70049; await migration.advanceLegacy(entries); assert.equal(stops, 0);
    now = 70050; await migration.advanceLegacy(entries); assert.equal(stops, 1);
    await migration.advanceLegacy(entries); assert.equal(stops, 1);
    assert.deepEqual(events, [
      { event: 'legacy_exit_forced', tmuxName: 'claude-main', reason: 'exit_timeout' },
      { event: 'legacy_tmux_stopped', tmuxName: 'claude-main', reason: 'forced' },
    ]);
  });
}

test('failed exit submission does not start the sixty second timer', async () => {
  let now = 0, stops = 0;
  const migration = createLegacyMigration({ now: () => now,
    readLegacy: async name => ({ present: name === 'claude-main', tmuxName: name, runtime: 'codex', runId: null }),
    readLegacyStatus: async () => ({ state: 'idle', idle_seconds: 3 }),
    sendExit: async () => { throw Error('submission failed'); },
    session: { stop: async () => { stops++; } },
  });
  const entries = await migration.findLegacySessions(); await migration.advanceLegacy(entries);
  now = 60000; await migration.advanceLegacy(entries);
  assert.equal(entries[0].exitSent, false); assert.equal(entries[0].exitSentAt, undefined);
  assert.equal(stops, 0);
  now = 300000; await migration.advanceLegacy(entries); assert.equal(stops, 1);
});

for (const runtime of ['claude', 'codex']) {
  test(`${runtime} disappearance before the exit deadline skips forced stop`, async () => {
    let now = 0, present = true, exits = 0, stops = 0;
    const events = [];
    const migration = createLegacyMigration({ now: () => now,
      readLegacy: async name => ({ present: present && name === 'claude-main', tmuxName: name, runtime, runId: null }),
      readLegacyStatus: async () => ({ state: 'idle', idle_seconds: 3 }),
      sendExit: async () => { exits++; },
      session: { stop: async () => { stops++; } },
      diagnostic: (event, fields) => events.push({ event, ...fields }),
    });
    const entries = await migration.findLegacySessions(); await migration.advanceLegacy(entries);
    await migration.advanceLegacy(entries); await migration.advanceLegacy(entries);
    assert.equal(exits, 1);
    present = false; now = 59999; await migration.advanceLegacy(entries);
    assert.equal(entries[0].stopped, true); assert.equal(stops, 0);
    now = 60000; await migration.advanceLegacy(entries); assert.equal(stops, 0);
    assert.deepEqual(events, [{ event: 'legacy_tmux_stopped', tmuxName: 'claude-main', reason: 'exited' }]);
  });
}

for (const reason of ['exit_timeout', 'startup_timeout']) {
  test(`${reason} logs forced exit once while failed stops keep retrying`, async () => {
    let now = 0, stops = 0;
    const events = [];
    const migration = createLegacyMigration({ now: () => now,
      readLegacy: async name => ({ present: name === 'claude-main', tmuxName: name, runtime: 'claude', runId: null }),
      readLegacyStatus: async () => ({ state: reason === 'exit_timeout' ? 'idle' : 'busy', idle_seconds: 3 }),
      sendExit: async () => {},
      session: { stop: async () => { if (++stops <= 3) throw Error('stop failed'); } },
      diagnostic: (event, fields) => events.push({ event, ...fields }),
    });
    const entries = await migration.findLegacySessions();
    await migration.advanceLegacy(entries);
    now = reason === 'exit_timeout' ? 60000 : 300000;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await migration.advanceLegacy(entries);
      assert.equal(stops, attempt); assert.equal(entries[0].stopped, false);
      now += 1000;
    }
    await migration.advanceLegacy(entries);
    assert.equal(stops, 4); assert.equal(entries[0].stopped, true);
    await migration.advanceLegacy(entries); assert.equal(stops, 4);
    assert.deepEqual(events.filter(row => row.event === 'legacy_exit_forced'), [
      { event: 'legacy_exit_forced', tmuxName: 'claude-main', reason },
    ]);
    assert.equal(events.filter(row => row.event === 'legacy_stop_unconfirmed').length, 3);
    assert.equal(events.filter(row => row.event === 'legacy_tmux_stopped').length, 1);
  });
}


// Upgrade records as the router reads them: the marker that identified the
// upgrade at discovery, and that transaction's journal.
function upgradeRecords() {
  const records = { marker: { transactionId: 'tx-current', transactionDir: '/zylos/.backup/self-upgrade/tx-current' },
    journal: { transactionId: 'tx-current', phase: 'installing', cleanup: { complete: false } } };
  return Object.assign(records, {
    readUpgradeMarker: async () => { if (records.marker instanceof Error) throw records.marker; return records.marker; },
    readUpgradeJournal: async dir => {
      assert.equal(dir, '/zylos/.backup/self-upgrade/tx-current');
      if (records.journal instanceof Error) throw records.journal; return records.journal;
    },
    finish() { records.journal = { transactionId: 'tx-current', phase: 'upgrade_complete', cleanup: { complete: true } }; records.marker = null; },
  });
}
function upgradeMigration({ runtime, status = { state: 'busy', idle_seconds: 0 }, records = upgradeRecords() }) {
  const clock = { now: 0 }, calls = [], events = [];
  let present = true;
  const migration = createLegacyMigration({ now: () => clock.now,
    readLegacy: async name => ({ present: present && name === 'claude-main', tmuxName: name, runtime, runId: null }),
    readLegacyStatus: async () => (typeof status === 'function' ? status() : status),
    sendExit: async () => calls.push('exit'),
    session: { stop: async input => { calls.push(['stop', input]); present = false; } },
    readUpgradeMarker: records.readUpgradeMarker, readUpgradeJournal: records.readUpgradeJournal,
    diagnostic: (event, fields) => events.push({ event, ...fields }) });
  return { migration, clock, calls, events, records };
}

test('codex legacy session is stopped on the first round after the upgrade finishes', async () => {
  const f = upgradeMigration({ runtime: 'codex', status: null });
  const entries = await f.migration.findLegacySessions();
  f.clock.now = 1000; await f.migration.advanceLegacy(entries);
  assert.deepEqual(f.calls, []);
  f.records.finish(); f.clock.now = 2000; await f.migration.advanceLegacy(entries);
  assert.deepEqual(f.calls, [['stop', { tmuxName: 'claude-main', expectedRunId: null }]]);
  await f.migration.advanceLegacy(entries);
  assert.equal(entries[0].stopped, true);
  assert.deepEqual(f.events, [
    { event: 'legacy_exit_forced', tmuxName: 'claude-main', reason: 'upgrade_complete' },
    { event: 'legacy_tmux_stopped', tmuxName: 'claude-main', reason: 'forced' },
  ]);
});

test('codex already sent exit is stopped once the upgrade finishes', async () => {
  let idle = true;
  const f = upgradeMigration({ runtime: 'codex', status: () => ({ state: idle ? 'idle' : 'busy', idle_seconds: 5 }) });
  const entries = await f.migration.findLegacySessions();
  await f.migration.advanceLegacy(entries); idle = false;
  assert.deepEqual(f.calls, ['exit']);
  f.records.finish(); f.clock.now = 1000; await f.migration.advanceLegacy(entries);
  assert.deepEqual(f.calls.at(-1)[0], 'stop');
  assert.equal(f.events[0].reason, 'upgrade_complete');
});

test('claude idle after the upgrade gets exit and keeps the sixty second exit deadline', async () => {
  const f = upgradeMigration({ runtime: 'claude', status: { state: 'idle', idle_seconds: 3 } });
  const entries = await f.migration.findLegacySessions();
  f.records.finish(); f.clock.now = 1000; await f.migration.advanceLegacy(entries);
  assert.deepEqual(f.calls, ['exit']);
  f.clock.now = 60999; await f.migration.advanceLegacy(entries);
  assert.deepEqual(f.calls, ['exit']);
  f.clock.now = 61000; await f.migration.advanceLegacy(entries);
  assert.deepEqual(f.calls.at(-1), ['stop', { tmuxName: 'claude-main', expectedRunId: null }]);
  assert.equal(f.events[0].reason, 'exit_timeout');
});

test('claude busy after the upgrade is stopped without exit', async () => {
  const f = upgradeMigration({ runtime: 'claude', status: { state: 'busy', idle_seconds: 0 } });
  const entries = await f.migration.findLegacySessions();
  await f.migration.advanceLegacy(entries);
  f.records.finish(); f.clock.now = 1000; await f.migration.advanceLegacy(entries);
  assert.deepEqual(f.calls, [['stop', { tmuxName: 'claude-main', expectedRunId: null }]]);
  assert.equal(f.events[0].reason, 'upgrade_complete');
});

test('claude that received exit before the upgrade finished is not stopped early', async () => {
  let idle = true;
  const f = upgradeMigration({ runtime: 'claude', status: () => ({ state: idle ? 'idle' : 'busy', idle_seconds: 5 }) });
  const entries = await f.migration.findLegacySessions();
  await f.migration.advanceLegacy(entries); idle = false;
  f.records.finish(); f.clock.now = 59999; await f.migration.advanceLegacy(entries);
  assert.deepEqual(f.calls, ['exit']);
  f.clock.now = 60000; await f.migration.advanceLegacy(entries);
  assert.equal(f.calls.at(-1)[0], 'stop'); assert.equal(f.events[0].reason, 'exit_timeout');
});

const unfinished = {
  'journal still installing': records => { records.marker = null; },
  'complete journal while the marker is still published': records => {
    records.journal = { transactionId: 'tx-current', phase: 'upgrade_complete', cleanup: { complete: true } };
  },
  'complete journal with cleanup pending': records => {
    records.marker = null; records.journal = { transactionId: 'tx-current', phase: 'upgrade_complete', cleanup: { complete: false } };
  },
  'restored instead of upgraded': records => {
    records.marker = null; records.journal = { transactionId: 'tx-current', phase: 'restored_complete', cleanup: { complete: true } };
  },
  'journal of another transaction': records => {
    records.marker = null; records.journal = { transactionId: 'tx-other', phase: 'upgrade_complete', cleanup: { complete: true } };
  },
  'marker now names another upgrade': records => {
    records.finish(); records.marker = { transactionId: 'tx-next', transactionDir: '/zylos/.backup/self-upgrade/tx-next' };
  },
  'unreadable journal': records => { records.marker = null; records.journal = new SyntaxError('broken'); },
  'unreadable marker': records => { records.finish(); records.marker = new Error('EACCES'); },
};
for (const [name, change] of Object.entries(unfinished)) {
  test(`${name}: legacy session waits for the 300 second deadline`, async () => {
    const f = upgradeMigration({ runtime: 'codex', status: null });
    const entries = await f.migration.findLegacySessions();
    change(f.records);
    f.clock.now = 299999; await f.migration.advanceLegacy(entries);
    assert.deepEqual(f.calls, []);
    f.clock.now = 300000; await f.migration.advanceLegacy(entries);
    assert.equal(f.calls.at(-1)[0], 'stop'); assert.equal(f.events[0].reason, 'startup_timeout');
  });
}

test('upgrade in progress still lets idle claude exit gracefully', async () => {
  const f = upgradeMigration({ runtime: 'claude', status: { state: 'idle', idle_seconds: 3 } });
  const entries = await f.migration.findLegacySessions();
  await f.migration.advanceLegacy(entries);
  assert.deepEqual(f.calls, ['exit']);
});

for (const [name, marker] of [['no active upgrade marker', null], ['unreadable active upgrade marker', new Error('broken')]]) {
  test(`${name} at discovery keeps the 300 second deadline after a later completion`, async () => {
    const records = upgradeRecords(); records.marker = marker;
    const f = upgradeMigration({ runtime: 'codex', status: null, records });
    const entries = await f.migration.findLegacySessions();
    records.finish(); f.clock.now = 299999; await f.migration.advanceLegacy(entries);
    assert.deepEqual(f.calls, []);
    f.clock.now = 300000; await f.migration.advanceLegacy(entries);
    assert.equal(f.events[0].reason, 'startup_timeout');
  });
}

test('unknown runtime is not stopped early after the upgrade finishes', async () => {
  const f = upgradeMigration({ runtime: 'unknown', status: null });
  const entries = await f.migration.findLegacySessions();
  f.records.finish(); f.clock.now = 1000; await f.migration.advanceLegacy(entries);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.events, []);
});

for (const health of ['ok', 'auth_failed']) {
  test(`single resident starts without queued work even when health is ${health}`, async t => {
    const f = routerFixture(t, { mode: 'single' });
    f.health.set('claude', { health });
    f.deps.readRuntimeHealth = () => assert.fail('single resident startup does not read runtime health');
    const router = f.create(); await router.initialize(); await f.rounds(2);
    f.advance(4999); await f.rounds(2);
    assert.equal(f.calls.filter(row => row[0] === 'launch').length, 0);
    f.advance(1); await f.rounds(2);
    assert.equal(f.calls.filter(row => row[0] === 'launch').length, 1);
    assert.equal(f.calls.find(row => row[0] === 'launch')[1].sessionGroup, null);
    assert.equal(f.calls.filter(row => row[0] === 'submit').length, 0);
  });
}

test('failed Origin launches retain the five ten twenty forty sixty second backoff', async t => {
  const f = routerFixture(t);
  f.db.insertControl('Needed work', { sessionGroup: 'origin', appendAckSuffix: false });
  f.deps.session = {
    launch: async input => { f.calls.push(['launch', input]); throw new Error('launch failed'); },
    stop: async input => { f.calls.push(['stop', input]); },
  };
  const router = f.create(); await router.initialize(); await f.rounds(2);
  for (const [index, delay] of [5000, 10000, 20000, 40000, 60000].entries()) {
    f.advance(delay - 1); await f.rounds(2);
    assert.equal(f.calls.filter(row => row[0] === 'launch').length, index);
    f.advance(1); await f.rounds(2);
    assert.equal(f.calls.filter(row => row[0] === 'launch').length, index + 1);
    assert.equal(router.state.resident.failures, index + 1);
  }
});

test('a stable ready Origin clears failure backoff before an hour asleep and a fresh demand', async t => {
  const f = routerFixture(t);
  f.db.insertControl('Initial work', { sessionGroup: 'origin', appendAckSuffix: false });
  const adapter = f.deps.session;
  let failuresLeft = 2;
  f.deps.session = { ...adapter, launch: async input => {
    if (failuresLeft-- > 0) { f.calls.push(['launch', input]); throw new Error('launch failed'); }
    return adapter.launch(input);
  } };
  const router = f.create(); await router.initialize(); await f.rounds(2);
  for (const delay of [5000, 10000, 20000]) { f.advance(delay); await f.rounds(3); }
  assert.equal(router.state.resident.failures, 3);
  f.advance(60000); await f.rounds(2);
  assert.equal(router.state.resident.failures, 0);
  f.scene.delete('origin'); f.current.delete('origin'); await f.rounds(2);
  const count = f.calls.filter(row => row[0] === 'launch').length;
  f.advance(3600000); await f.rounds(3);
  assert.equal(f.calls.filter(row => row[0] === 'launch').length, count);
  f.db.insertControl('Fresh demand', { sessionGroup: 'origin', appendAckSuffix: false });
  await f.rounds(1);
  assert.equal(f.calls.filter(row => row[0] === 'launch').length, count + 1);
});

test('legacy migration only observes the two runtimes that predate managed groups', async () => {
  const names = [];
  const migration = createLegacyMigration({
    readLegacy: async tmuxName => { names.push(tmuxName); return { present: false }; },
    readLegacyStatus: async () => assert.fail('Absent legacy session has no status'),
    sendExit: async () => assert.fail('No legacy session should be stopped'),
    session: { stop: () => assert.fail('Absent legacy session should not reach stop') },
    readUpgradeMarker: async () => assert.fail('Upgrade records are read only for found legacy sessions'),
  });
  assert.deepEqual(await migration.findLegacySessions(), []);
  assert.deepEqual(names, ['claude-main', 'codex-main']);
});
