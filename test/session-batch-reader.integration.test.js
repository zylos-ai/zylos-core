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
for (const mutation of ['run identity', 'ready identity', 'pane identity', 'server replacement']) {
  test(`batch rejects samples after ${mutation} changes`, { timeout: 20000 }, async t => {
    const f = batchFixture(t);
    f.add('origin');
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
