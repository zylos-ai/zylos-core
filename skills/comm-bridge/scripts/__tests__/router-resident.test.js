import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture } from './helpers/router-fixture.js';
import { createSinglePreparation, createLegacyMigration, runningMaintenance } from '../router/resident.js';

test('single preparation waits at most 300 seconds, then cleanup and instruction generation in order', async () => {
  let now = 0; const calls = [];
  const prepare = createSinglePreparation({ now: () => now, sleep: async ms => { now += ms; }, checkMaintenance: async () => 'upgrade',
    clearStaleState: async runtime => calls.push(['clear',runtime]), resetToolLifecycle: async runtime => calls.push(['reset',runtime]),
    buildInstructionFile: async runtime => calls.push(['instructions',runtime]) });
  await prepare('codex'); assert.equal(now, 300000);
  assert.deepEqual(calls, [['clear','codex'],['reset','codex'],['instructions','codex']]);
});

test('maintenance scan is async argv-only and distinguishes no match from observation failure', async () => {
  const patterns = [];
  assert.equal(await runningMaintenance({ execute: async (_,args) => { patterns.push(args); if (patterns.length < 2) throw Object.assign(Error(),{code:1}); } }), '[u]pgrade-claude');
  assert.deepEqual(patterns, [['-f','[r]estart-claude'],['-f','[u]pgrade-claude']]);
  await assert.rejects(runningMaintenance({ execute: async () => { throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'}); } }), /timeout/);
});

test('legacy waits idle, sends exit once, confirms disappearance; busy target forced at 300s by observed runtime', async () => {
  let now = 0; const live = new Map([['claude-main',{ present:true,tmuxName:'claude-main',runtime:'claude',runId:null }],
    ['codex-main',{ present:true,tmuxName:'codex-main',runtime:'codex',runId:'old' }]]);
  const calls = [];
  const migration = createLegacyMigration({ now: () => now, readLegacy: async name => live.get(name) ?? {present:false},
    readLegacyStatus: async name => ({state:name==='claude-main'?'idle':'busy', idle_seconds:4}),
    sendExit: async target => calls.push(['exit',target.tmuxName]), getSessionAdapter: runtime => ({stop: async input => { calls.push(['stop',runtime,input]); live.delete(input.tmuxName); }}),
    diagnostic: (event, fields) => calls.push([event,fields]) });
  const entries = await migration.findLegacySessions(); await migration.advanceLegacy(entries); await migration.advanceLegacy(entries);
  assert.deepEqual(calls.filter(x => x[0]==='exit'), [['exit','claude-main']]);
  live.delete('claude-main'); await migration.advanceLegacy(entries);
  now = 299999; await migration.advanceLegacy(entries);
  assert.equal(calls.some(x => x[0] === 'stop'), false);
  now = 300000; await migration.advanceLegacy(entries);
  assert.deepEqual(calls.find(x => x[0]==='stop'), ['stop','codex',{tmuxName:'codex-main',expectedRunId:'old'}]);
  assert.deepEqual(calls.filter(x => x[0]==='legacy_tmux_stopped').map(x => x[1].reason), ['exited','forced']);
});

test('unknown legacy runtime never guesses adapter; failed stop remains pending', async () => {
  let now = 0, runtime = 'unknown', stopCount = 0;
  const migration = createLegacyMigration({ now:()=>now, readLegacy:async name => ({present:name==='claude-main',runtime,tmuxName:name,runId:null}),
    readLegacyStatus:async()=>({state:'busy'}),sendExit:async()=>assert.fail('busy'),getSessionAdapter:()=>({stop:async()=>{stopCount++;throw Error('unconfirmed');}}) });
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
      getSessionAdapter: () => ({ stop: async () => { stops++; } }),
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
    getSessionAdapter: () => ({ stop: async () => { stops++; } }),
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
      getSessionAdapter: () => ({ stop: async () => { stops++; } }),
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
      getSessionAdapter: () => ({ stop: async () => { if (++stops <= 3) throw Error('stop failed'); } }),
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
  f.deps.getSessionAdapter = () => ({
    launch: async input => { f.calls.push(['launch', input]); throw new Error('launch failed'); },
    stop: async input => { f.calls.push(['stop', input]); },
  });
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
  const adapter = f.deps.getSessionAdapter;
  let failuresLeft = 2;
  f.deps.getSessionAdapter = runtime => ({ ...adapter(runtime), launch: async input => {
    if (failuresLeft-- > 0) { f.calls.push(['launch', input]); throw new Error('launch failed'); }
    return adapter(runtime).launch(input);
  } });
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
