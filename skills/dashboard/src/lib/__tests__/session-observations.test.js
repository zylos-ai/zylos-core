import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionObservations } from '../session-observations.js';
import { CoreState } from '../core-state.js';

const observation = (runtime = 'claude', runId = 'run') => ({
  identity: { present: true, ready: true, runId, sessionId: 'session', runtime },
  status: { valid: true, reason: null, value: { state: 'idle' }, sampledAt: 1 },
  usage: { valid: true, value: { context_window: { used_percentage: 42 } }, sampledAt: 1 },
});
function fixture({ read, clock = () => 1000 } = {}) {
  let batches = 0;
  const modules = {
    'config.js': { readSessionMode: () => ({ mode: 'multi' }) },
    'session-state-reader.js': {
      readSessionStates: async (groups, options) => {
        batches++;
        assert.deepEqual(groups, ['origin']);
        assert.equal(options.includeAllLive, true);
        assert.equal(options.usageFreshnessMs, Infinity);
        return read ? read(options, batches) : new Map([['origin', observation()]]);
      },
      readRuntimeHealth: () => ({ missing: true }),
      resolveTargetRuntime: () => assert.fail('Live runtime must come from the shared observation'),
    },
    'session-usage-reader.js': {}, 'session-group-paths.js': {},
    'recorded-account-usage.js': { readRecordedAccountUsage: (_runtime, _env, _now, samples) => samples[0] ?? null },
  };
  const provider = createSessionObservations({ now: clock, loadCoreModule: async name => {
    assert.ok(name in modules, name);
    return modules[name];
  } });
  return { provider, batches: () => batches };
}

test('concurrent readers and a round reuse one all-live batch; expiry observes again', async () => {
  let at = 1000;
  const { provider, batches } = fixture({ clock: () => at });
  const [first, second] = await Promise.all([provider.get(), provider.get()]);
  assert.equal(first, second);
  assert.equal(batches(), 1);
  assert.equal(await provider.get(), first);
  at += 2500;
  assert.notEqual(await provider.get(), first);
  assert.equal(batches(), 2);
});

test('fresh identity requests wait for an older pending batch and then observe again', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { provider, batches } = fixture({ read: async (_options, count) => {
    if (count === 1) await pending;
    return new Map([['origin', observation('claude', `run-${count}`)]]);
  } });
  const old = provider.get();
  const fresh = provider.get({ fresh: true });
  release();
  assert.equal((await old).observations.get('origin').identity.runId, 'run-1');
  assert.equal((await fresh).observations.get('origin').identity.runId, 'run-2');
  assert.equal(batches(), 2);
});

test('all runtimes choose their latest validated live account sample without another batch', async () => {
  const { provider, batches } = fixture({ read: async () => new Map([
    ['origin', { ...observation(), sampled: { value: { quota: 1 }, mtime: 1, recordedAt: 1 } }],
    ['other', { ...observation(), sampled: { value: { quota: 2 }, mtime: 2, recordedAt: 2 } }],
    ['codex', { ...observation('codex'), sampled: { value: { quota: 3 }, mtime: 3, recordedAt: 3 } }],
    ['changed', { ...observation(), observationError: new Error('changed'), sampled: { value: { quota: 99 }, mtime: 99 } }],
  ]) });
  await provider.get();
  assert.deepEqual((await provider.reader.readAccountUsageSnapshot('claude')).live, { quota: 2 });
  assert.deepEqual((await provider.reader.readAccountUsageSnapshot('codex')).live, { quota: 3 });
  assert.equal(batches(), 1);
});

test('CoreState is dormant unwatched and shares live runtime with fleet observations', async t => {
  const { provider, batches } = fixture();
  let samples = 0;
  const state = new CoreState({ sessionObservations: provider, onSample: () => samples++,
    accountUsageCache: { read: async () => null } });
  t.after(() => state.stop());
  await state.start();
  assert.equal(batches(), 0);
  assert.equal(state.timer, undefined);
  await Promise.all([state.refresh(), provider.get()]);
  assert.equal(batches(), 1);
  assert.equal(samples, 1);
  assert.equal(state.getState().runtime, 'claude');
  state.setWatched(true);
  assert.ok(state.timer);
  state.setWatched(false);
  assert.equal(state.timer._destroyed, true);
});

test('currentTarget forces a new identity and rejects an identity that changed in observation', async t => {
  let changed = false;
  const { provider, batches } = fixture({ read: async () => {
    const item = observation();
    if (changed) item.status = { valid: false, reason: 'identity_changed' };
    return new Map([['origin', item]]);
  } });
  const state = new CoreState({ sessionObservations: provider, accountUsageCache: { read: async () => null } });
  t.after(() => state.stop());
  await state.refresh();
  changed = true;
  await assert.rejects(state.currentTarget(), { code: 'target_unavailable' });
  assert.equal(batches(), 2);
});

test('failed observations clear cached identities and notify fleet sampling without a valid target', async t => {
  let fail = false;
  const { provider } = fixture({ read: async () => {
    if (fail) throw new Error('session read unavailable');
    return new Map([['origin', observation()]]);
  } });
  let samples = 0;
  const state = new CoreState({ sessionObservations: provider, onSample: () => samples++,
    accountUsageCache: { read: async () => null } });
  t.after(() => state.stop());
  await state.refresh();
  assert.ok(provider.peek());
  fail = true;
  await assert.rejects(state.currentTarget(), { code: 'target_unavailable' });
  assert.equal(provider.peek(), null);
  assert.equal(state.getState().state, 'UNKNOWN');
  assert.equal(samples, 2);
});

test('agy Origin state and runtime health remain available without account collection', async t => {
  let sampled = false;
  const provider = createSessionObservations({ loadCoreModule: async name => {
    if (name === 'config.js') return { readSessionMode: () => ({ mode: 'multi' }) };
    if (name === 'session-state-reader.js') return {
      readSessionStates: async (_groups, options) => {
        assert.equal(options.sampleTarget('origin', observation('agy').identity), null);
        sampled = true;
        return new Map([['origin', observation('agy')]]);
      },
      readRuntimeHealth: runtime => { assert.equal(runtime, 'agy'); return { health: 'ok' }; },
    };
    if (['session-usage-reader.js', 'session-group-paths.js'].includes(name)) return {};
    assert.fail(`agy state must not load an account collector: ${name}`);
  } });
  const state = new CoreState({ sessionObservations: provider,
    accountUsageCache: { read: () => assert.fail('agy has no account collection') } });
  t.after(() => state.stop());
  assert.equal((await state.refresh()).state, 'IDLE');
  assert.equal(state.getState().runtime, 'agy');
  assert.equal(state.accountUsage, null);
  assert.equal((await state.currentTarget()).runtime, 'agy');
  assert.equal(sampled, true);
  assert.deepEqual(await provider.reader.readRuntimeHealth('agy'), { health: 'ok' });
});

// The heartbeat's dormancy check reads Origin's entry from the shared batch
// instead of opening its own tmux connection.
test('Origin presence comes from the shared batch and reuses its cache', async () => {
  const entry = present => ({ ...observation(), identity: { ...observation().identity, present } });
  let present = true;
  const { provider, batches } = fixture({ read: () => new Map([['origin', entry(present)]]) });
  await provider.get();
  assert.equal(await provider.originPresence(), true);
  assert.equal(batches(), 1, 'presence reuses the cached batch');
  // Native single reads Origin's live session; without the key the one null-group session is read.
  const single = (value, mode = 'single') => createSessionObservations({ now: () => 1000, loadCoreModule: async name => ({
    'config.js': { readSessionMode: () => { if (mode === 'unreadable') throw new Error('unreadable configuration'); return { mode }; } },
    'session-state-reader.js': { readSessionStates: async groups => {
      assert.deepEqual(groups, [mode === 'single' ? 'origin' : null]);
      return new Map(value ? [[groups[0], value]] : []);
    } },
    'session-usage-reader.js': {}, 'session-group-paths.js': {},
  })[name] });
  assert.equal(await single(entry(false)).originPresence(), false);
  assert.equal(await single(entry(true)).originPresence(), true);
  assert.equal(await single(entry(true), null).originPresence(), true, 'an instance without the key reads its null-group session');
  assert.equal(await single(null).originPresence(), null, 'a missing Origin entry is unknown, not absent');
  await assert.rejects(single(null, 'unreadable').originPresence(), /unreadable configuration/,
    'an unreadable observation rejects, which the heartbeat treats as unknown');
});
