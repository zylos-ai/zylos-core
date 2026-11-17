import test from 'node:test';
import assert from 'node:assert/strict';
import { batchFixture } from './helpers/session-batch-fixture.js';

const options = { freshnessMs: 60000 };

// Boundary: real tmux environment/format decoding and local status/usage binding.
// Run after reader, tmux observation/parser or session identity changes; skip for UI-only changes.
test('batch states match individual reads for ready, missing and pane-only sessions', { timeout: 20000 }, async t => {
  const f = batchFixture(t);
  f.add('origin', { model: '模型\\$HOME\nline\tvalue' });
  f.add('worker');
  f.add('pane-only', { paneOnly: true });
  f.tmux('new-session', '-d', '-s', 'unrelated', 'sleep', '600');
  const groups = ['origin', 'worker', 'missing', 'pane-only'];
  const batch = await f.reader.readSessionStates(groups, options);
  assert.equal(batch.size, groups.length);
  for (const group of groups) {
    const individual = await f.reader.readSessionState(group, options);
    const { identity, status, usage } = batch.get(group);
    assert.deepEqual({ identity, status, usage }, individual);
  }
  assert.equal(batch.get('origin').usage.valid, true);
  assert.equal(batch.get('missing').status.reason, 'not_running');
  assert.equal(batch.get('pane-only').status.reason, 'starting');
  const identities = await f.reader.readLiveIdentities(groups);
  for (const group of groups) assert.deepEqual(identities.get(group), batch.get(group).identity);
  const listed = await f.reader.readLiveIdentities();
  assert.equal(listed.size, 3);
  assert.equal(listed.has('unrelated'), false);
});

// Boundary: one/two ordinary client commands per observation/read independent of N.
// Run after batching or tmux invocation changes; skip for scheduling-only changes.
for (const count of [6, 12]) test(`batch command count is bounded for ${count} sessions`, { timeout: 20000 }, async t => {
  const f = batchFixture(t);
  const groups = Array.from({ length: count }, (_, i) => `worker-${i}`);
  groups.forEach(group => f.add(group));
  f.commands.length = 0;
  const states = await f.reader.readSessionStates(groups, options);
  assert.equal(states.size, count);
  assert.equal(f.commands.length, 2);
  for (const argv of f.commands) { assert.equal(argv[0], 'list-panes'); assert(argv.includes('-a')); }
  f.commands.length = 0;
  await f.reader.readLiveIdentities(groups);
  assert.equal(f.commands.length, 1);
  f.commands.length = 0;
  assert.equal((await f.reader.readAccountUsage('claude')).five_hour.used_percentage, 23);
  assert.equal(f.commands.length, 2);
});

// Boundary: mutation is injected immediately before the second real list-panes,
// after the local sample. No product source is rewritten and both observations are real.
// Run after reader identity validation or tmux generation changes; skip for UI-only changes.
for (const mutation of ['run identity', 'ready identity', 'pane identity', 'session identity', 'server replacement', 'session disappearance']) {
  test(`batch rejects samples after ${mutation} changes`, { timeout: 20000 }, async t => {
    const f = batchFixture(t);
    f.add('origin');
    if (mutation === 'session identity') f.add('keeper');
    let observations = 0;
    f.setBeforeCommand(async argv => {
      if (argv[0] !== 'list-panes' || ++observations !== 2) return;
      if (mutation === 'run identity') f.tmux('set-environment', '-t', 'zylos-group-origin', 'ZYLOS_RUN_ID', 'new-run');
      if (mutation === 'ready identity') f.write('origin', 'current-session.json', { runId: 'run-origin', sessionId: 'new-session', ts: Date.now(), startupControlIds: [] });
      if (mutation === 'pane identity') {
        const oldPane = f.tmux('display-message', '-p', '-t', 'zylos-group-origin:', '#{pane_id}');
        f.tmux('split-window', '-d', '-t', oldPane, 'sleep', '600');
        f.tmux('kill-pane', '-t', oldPane);
      }
      if (mutation === 'session identity') {
        f.tmux('kill-session', '-t', 'zylos-group-origin');
        f.add('origin');
      }
      if (mutation === 'session disappearance') f.tmux('kill-session', '-t', 'zylos-group-origin');
      if (mutation === 'server replacement') {
        f.tmux('kill-server');
        await f.waitForServerExit();
        f.add('origin');
      }
    });
    const result = (await f.reader.readSessionStates(['origin'], options)).get('origin');
    assert.equal(observations, 2);
    assert.equal(result.status.valid, false);
    assert.equal(result.usage.valid, false);
    assert.equal(result.status.reason, 'identity_changed');
    assert.equal(result.usage.reason, 'identity_changed');
    assert.equal(result.target.ready, false);
    assert.equal(result.target.runtime, 'unknown');
    assert.equal(result.observationError.code, 'TARGET_GONE');
  });
}

// Boundary: absent isolated server remains absent, and subsequent replacement is read freshly.
// Run after socket/error handling changes; skip for UI-only changes.
test('batch handles absent server then reads a replacement server', { timeout: 20000 }, async t => {
  const f = batchFixture(t);
  const before = await f.reader.readSessionStates(['origin'], options);
  assert.equal(before.get('origin').status.reason, 'not_running');
  assert.equal((await f.reader.readLiveIdentities()).size, 0);
  f.add('origin');
  assert.equal((await f.reader.readSessionStates(['origin'], options)).get('origin').status.valid, true);
  f.tmux('kill-server');
  await f.waitForServerExit();
  f.add('origin', { runId: 'replacement' });
  const after = (await f.reader.readSessionStates(['origin'], options)).get('origin');
  assert.equal(after.identity.runId, 'replacement');
  assert.equal(after.usage.valid, true);
});

// Boundary: length framing and reversible session environment encoding across supported tmux versions.
// Run after format/parser/environment changes; skip for scheduling or UI-only changes.
test('batch preserves Unicode and environment metacharacters without mixing rows', { timeout: 20000 }, async t => {
  const f = batchFixture(t);
  const values = ['unicode-模型🦑', 'dollar-$HOME-${HOME}-$x', 'at-@@-@b-@d',
    'slash-\\-\\$HOME-\\\\${foo}', 'controls-\t-\n-\r-\u0001', 'quotes-"-\'-`-;#{pane_id}'];
  for (const [index, model] of values.entries()) f.add(`env-${index}`, { model, runId: `run-${model}` });
  const groups = values.map((_, index) => `env-${index}`);
  const identities = await f.reader.readLiveIdentities(groups);
  for (const [index, group] of groups.entries()) {
    const individual = await f.reader.readLiveIdentity(group);
    assert.deepEqual(identities.get(group), individual);
    assert.equal(identities.get(group).launchConfig.model, values[index]);
    assert.equal(identities.get(group).runId, `run-${values[index]}`);
  }
});

// Boundary: account quota samples retain both surrounding identity checks.
// Run after account reader or identity validation changes; skip for UI-only changes.
test('account usage discards samples from a replaced run', { timeout: 20000 }, async t => {
  const f = batchFixture(t);
  f.add('origin');
  let observations = 0;
  f.setBeforeCommand(argv => {
    if (argv[0] === 'list-panes' && ++observations === 2) {
      f.tmux('set-environment', '-t', 'zylos-group-origin', 'ZYLOS_RUN_ID', 'replacement-run');
    }
  });
  assert.equal(await f.reader.readAccountUsage('claude'), null);
  assert.equal(observations, 2);
});

// Boundary: the batched target must be the active pane in the active window,
// and older non-Origin sessions without scope environment retain individual-reader semantics.
// Run after pane selection or scope fallback changes; skip for UI-only changes.
test('batch matches active target selection and sessions missing scope environment', { timeout: 20000 }, async t => {
  const f = batchFixture(t);
  f.add('origin'); f.add('worker');
  f.tmux('set-environment', '-u', '-t', 'zylos-group-worker', 'ZYLOS_SESSION_GROUP');
  f.tmux('new-window', '-t', 'zylos-group-worker', '-n', 'other', 'sleep', '600');
  f.tmux('split-window', '-t', 'zylos-group-worker:other', 'sleep', '600');
  const individual = await f.reader.readSessionState('worker', options);
  const batch = (await f.reader.readSessionStates(['worker'], options)).get('worker');
  assert.deepEqual(batch.identity, individual.identity);
  assert.deepEqual(batch.status, individual.status);
  assert.deepEqual(batch.usage, individual.usage);
  assert.equal(batch.target.paneId, f.tmux('display-message', '-p', '-t', 'zylos-group-worker:', '#{pane_id}'));
  assert.equal(batch.usage.valid, true);
  f.tmux('set-environment', '-u', '-t', 'zylos-group-origin', 'ZYLOS_SESSION_GROUP');
  const single = (await f.reader.readSessionStates([null], options)).get(null);
  assert.deepEqual(single.identity, await f.reader.readLiveIdentity(null));
  assert.equal(single.status.valid, true);
});

// Boundary: format lookup must not inherit global values missing from a session.
// Run after batch/environment changes; skip for scheduling or UI-only changes.
test('batch matches session-only environment when global values collide', { timeout: 20000 }, async t => {
  const f = batchFixture(t);
  f.add('absent'); f.add('explicit'); f.add('removed');
  for (const key of ['ZYLOS_RUN_ID', 'ZYLOS_MODEL_CONFIG', 'ZYLOS_SESSION_GROUP']) {
    const value = key === 'ZYLOS_RUN_ID' ? 'global-run' : key === 'ZYLOS_SESSION_GROUP' ? 'global-group' : JSON.stringify({ runtime: 'claude', model: 'global-model' });
    f.tmux('set-environment', '-g', key, value);
    f.tmux('set-environment', '-u', '-t', 'zylos-group-absent', key);
    f.tmux('set-environment', '-t', 'zylos-group-explicit', key, value);
    f.tmux('set-environment', '-r', '-t', 'zylos-group-removed', key);
  }
  f.commands.length = 0;
  const batch = await f.reader.readLiveIdentities(['absent', 'explicit', 'removed']);
  assert.equal(f.commands.length, 2, 'global collisions add one shared client, never one client per session');
  assert.equal(f.commands.some(argv => argv.includes('if-shell')), false, 'collision reads never invoke the write guard');
  for (const group of ['absent', 'explicit', 'removed']) assert.deepEqual(batch.get(group), await f.reader.readLiveIdentity(group));
  assert.equal(batch.get('absent').runId, null);
  assert.equal(batch.get('removed').runId, null);
  assert.equal(batch.get('explicit').runId, 'global-run');
});

// Boundary: collision fallback must validate the identities captured by list-panes.
// Run after fallback framing or identity changes; skip for scheduling/UI-only changes.
for (const mutation of ['same-name replacement', 'server replacement']) {
  test(`collision fallback rejects ${mutation} after the initial list`, { timeout: 20000 }, async t => {
    const f = batchFixture(t);
    f.add('origin'); f.add('keeper');
    f.tmux('set-environment', '-g', 'ZYLOS_RUN_ID', 'run-origin');
    let replaced = false;
    f.setBeforeCommand(async argv => {
      if (argv[0] === 'list-panes' || replaced) return;
      assert(argv.includes('show-environment'), 'mutation must precede collision fallback');
      replaced = true;
      if (mutation === 'server replacement') {
        f.tmux('kill-server');
        await f.waitForServerExit();
      } else f.tmux('kill-session', '-t', 'zylos-group-origin');
      f.add('origin');
    });
    await assert.rejects(f.reader.readLiveIdentities(['origin']),
      { code:mutation === 'server replacement' ? 'GENERATION_CHANGED' : 'TARGET_GONE' });
    assert.equal(replaced, true);
    assert.equal(f.commands.length, 2);
    assert.equal(f.commands.some(argv => argv.includes('if-shell')), false);
  });
}

// Boundary: each real list-panes sees multiple active panes/windows, only one is selected.
// Run after active target filtering changes; skip for UI-only changes.
test('batch selects only active pane of active window', { timeout: 20000 }, async t => {
  const f = batchFixture(t);
  f.add('worker');
  const original = f.tmux('display-message', '-p', '-t', 'zylos-group-worker:', '#{pane_id}');
  f.tmux('split-window', '-d', '-t', original, 'sleep', '600');
  f.tmux('new-window', '-d', '-t', 'zylos-group-worker', '-n', 'inactive', 'sleep', '600');
  f.tmux('split-window', '-d', '-t', 'zylos-group-worker:inactive', 'sleep', '600');
  for (const target of ['zylos-group-worker:inactive', original]) {
    f.tmux('select-window', '-t', target);
    f.tmux('select-pane', '-t', target);
    const paneId = f.tmux('display-message', '-p', '-t', 'zylos-group-worker:', '#{pane_id}');
    const batch = await f.reader.readSessionTargets();
    assert.equal(batch.size, 1);
    assert.equal(batch.get('worker').paneId, paneId);
    assert.deepEqual((await f.reader.readLiveIdentities(['worker'])).get('worker'), await f.reader.readLiveIdentity('worker'));
  }
});

// Boundary: readiness cannot bind stale runs or malformed startup acknowledgement ids.
// Run after readiness validation changes; skip for scheduling/UI-only changes.
for (const [name, patch] of [
  ['stale run', { runId:'old-run' }],
  ['missing startup ids', { startupControlIds:null }],
  ['non-array startup ids', { startupControlIds:{} }],
  ['fractional startup id', { startupControlIds:[1.5] }],
  ['string startup id', { startupControlIds:['1'] }],
  ['invalid startup timestamp', { ts:'now' }],
]) test(`batch rejects current session with ${name}`, { timeout: 20000 }, async t => {
  const f = batchFixture(t);
  f.add('origin');
  f.write('origin', 'current-session.json', { runId:'run-origin', sessionId:'sid-origin', ts:Date.now(), startupControlIds:[], ...patch });
  const batch = (await f.reader.readSessionStates(['origin'], options)).get('origin');
  assert.deepEqual(batch.identity, await f.reader.readLiveIdentity('origin'));
  assert.equal(batch.target.ready, false);
  assert.equal(batch.target.f3, null);
  assert.equal(batch.status.reason, 'starting');
  assert.equal(batch.usage.reason, 'starting');
});

// Boundary: failures on the final observation cannot publish trusted samples;
// unavailable responses propagate the same public code used by individual reads.
// Run after batch error handling changes; skip for UI-only changes.
for (const code of ['TMUX_COMMAND_FAILED', 'TMUX_RESPONSE_INVALID', 'TMUX_NO_SERVER']) {
  test(`batch handles second observation ${code}`, { timeout: 20000 }, async t => {
    const f = batchFixture(t);
    f.add('origin');
    let reads = 0;
    f.setBeforeCommand(argv => {
      if (argv[0] === 'list-panes' && ++reads === 2) throw Object.assign(new Error('isolated final observation failure'), { code });
    });
    if (code === 'TMUX_NO_SERVER') {
      const result = (await f.reader.readSessionStates(['origin'], options)).get('origin');
      assert.equal(result.target.ready, false);
      assert.equal(result.observationError.code, 'TARGET_GONE');
      assert.equal(result.status.reason, 'identity_changed');
      assert.equal(result.usage.valid, false);
    } else {
      await assert.rejects(f.reader.readSessionStates(['origin'], options), { code:'TMUX_UNAVAILABLE' });
    }
    assert.equal(reads, 2);
  });
}

// Boundary: caller sampling must occur within the same two-observation bracket.
// Run after sampling or reader bracketing changes; skip for UI-only changes.
test('batch brackets caller sampling and rejects a replacement during sampling', { timeout: 20000 }, async t => {
  const f = batchFixture(t);
  f.add('origin');
  const result = (await f.reader.readSessionStates(['origin'], { ...options, sampleTarget:async (group, target) => {
    assert.equal(group, 'origin');
    assert.equal(target.ready, true);
    assert.equal(f.commands.filter(argv => argv[0] === 'list-panes').length, 1);
    f.tmux('set-environment', '-t', 'zylos-group-origin', 'ZYLOS_RUN_ID', 'changed-during-sample');
    return { activity:'sampled' };
  } })).get('origin');
  assert.deepEqual(result.sampled, { activity:'sampled' });
  assert.equal(result.target.ready, false);
  assert.equal(result.observationError.code, 'TARGET_GONE');
  assert.equal(f.commands.filter(argv => argv[0] === 'list-panes').length, 2);
});

// Boundary: malformed real command responses use the public unavailable code.
// Run after response framing/parser changes; skip for UI-only changes.
for (const corruption of ['missing boundary', 'invalid framed row', 'unordered session boundary']) {
  test(`batch normalizes ${corruption} response`, { timeout: 20000 }, async t => {
    const f = batchFixture(t);
    f.add('origin');
    if (corruption === 'unordered session boundary') f.tmux('set-environment', '-g', 'ZYLOS_RUN_ID', 'run-origin');
    let corrupted = false;
    f.setAfterCommand((argv, output) => {
      if (corruption === 'missing boundary' && argv[0] === 'list-panes') return output.replace('ZYLOS_BATCH_GLOBAL', 'MISSING');
      if (corruption === 'invalid framed row' && argv[0] === 'list-panes') return output.replace(/\t\d+:zylos-group-origin/, '\tbad:zylos-group-origin');
      if (corruption === 'unordered session boundary' && argv.some(arg => arg.includes('ZYLOS_BATCH_SESSION_0'))) {
        corrupted = output.includes('ZYLOS_BATCH_SESSION_0');
        return output.replace('ZYLOS_BATCH_SESSION_0', 'ZYLOS_BATCH_SESSION_1');
      }
      return output;
    });
    await assert.rejects(f.reader.readLiveIdentities(['origin']), { code:'TMUX_UNAVAILABLE' });
    if (corruption === 'unordered session boundary') assert.equal(corrupted, true);
  });
}
