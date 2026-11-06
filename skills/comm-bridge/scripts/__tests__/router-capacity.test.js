import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as capacityReader from '../../../../cli/lib/session-pool-config.js';
import { routerFixture, flush } from './helpers/router-fixture.js';

const hardware = { platform: 'darwin', totalMemoryBytes: 4 * 1024 ** 3 };
const stats = new Map();
const filesystem = { ...fs, statSync(file, ...args) {
  if (file.endsWith('/pool-capacity.json')) stats.set(file, (stats.get(file) ?? 0) + 1);
  return fs.statSync(file, ...args);
} };
// Substitute only physical memory inputs; retain the shared reader, validation,
// fixed precedence, file parsing/cache and real scheduler/slot transactions.
mock.module(new URL('../../../../cli/lib/session-pool-config.js', import.meta.url).href, {
  namedExports: { ...capacityReader, readPoolCapacity: options =>
    capacityReader.readPoolCapacity({ ...options, ...hardware, fs: filesystem }) },
});
const { createDispatcher } = await import('../router/factory.js');

// Integration boundary: factory -> shared F16 reader -> scheduler -> real Store.
// Run for Router capacity wiring/freshness changes; skip delivery-only
// changes. Runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/TMUX_TMPDIR.
// Each case owns another private root and in-memory DB; runtime/scene/delivery
// providers are fixtures, no tmux/PM2/network. Stop before removing owned files.
async function fixture(t, { fixed, explicit, mode = 'multi', record } = {}) {
  const f = routerFixture(t, { mode });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-capacity-'));
  const env = { HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'pm2'),
    ZYLOS_SESSION_POOL_SIZE: explicit ?? '' };
  const config = { runtime: 'claude', session_mode: mode, ...(fixed ? { session_pool_size: fixed } : {}) };
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify(config));
  const file = path.join(root, 'activity-monitor/pool-capacity.json');
  let serial = 0;
  const write = value => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    // Ensure distinct cache identities even on coarse timestamp filesystems.
    const modified = new Date(f.now() + ++serial);
    fs.utimesSync(file, modified, modified);
  };
  if (record !== undefined) write(typeof record === 'function' ? record(f.now()) : record);
  const taken = [], take = f.db.takeSlot;
  f.db.takeSlot = (group, options) => { taken.push({ group, k: options.k }); return take(group, options); };
  if (mode === 'multi') f.put('origin');
  const router = createDispatcher({ ...f.deps, env, readZylosConfigStrict: () => ({ state: 'ok', config }),
    diagnostics: { diagnostic() {}, maintain() {} }, sendStatusNotice: async () => {},
  }, { readyTimeoutMs: 1000, delivery: { periodicEnabled: false } });
  t.after(async () => { await router.stop(); fs.rmSync(root, { recursive: true, force: true }); stats.delete(file); });
  await router.initialize(); await router.idle();
  const rounds = async (n = 3) => { for (let i = 0; i < n; i++) { router.tick(); await router.idle(); await flush(); } };
  return { ...f, router, rounds, env, config, file, write, taken,
    m4: record => capacityReader.readPoolCapacity({ ...hardware, env, config, record, now: f.now() }).k,
    reads: () => stats.get(file) ?? 0 };
}

const fresh = now => ({ v: 1, k: 3, source: 'auto', computedAt: now });
for (const [name, record, expected] of [
  ['fresh', fresh, 3],
  ['old', now => ({ ...fresh(now), computedAt: now - 61000 }), 2],
  ['old below baseline', now => ({ ...fresh(now), k: 1, computedAt: now - 61000 }), 1],
  ['future', now => ({ ...fresh(now), computedAt: now + 6000 }), 2],
  ['missing', undefined, 2],
  ['unsupported version', now => ({ ...fresh(now), v: 2 }), 2],
  ['zero', now => ({ ...fresh(now), k: 0 }), 2],
  ['string', now => ({ ...fresh(now), k: '3' }), 2],
  ['truncated', '{"v":1,', 2],
]) {
  test(`dispatcher passes ${name} publication capacity to slot admission`, async t => {
    const f = await fixture(t, { record });
    f.add('new'); await f.rounds();
    assert.equal(f.taken.find(row => row.group === 'new')?.k, expected);
    assert.ok(f.calls.some(row => row[0] === 'launch' && row[1].sessionGroup === 'new'));
    const m4record = typeof record === 'function' ? record(f.now()) : null;
    if (name === 'fresh' || name.startsWith('old')) assert.equal(expected, f.m4(m4record));
    else assert.ok(expected <= f.m4(m4record));
  });
}

for (const [name, record] of [
  ['missing', undefined], ['stale', now => ({ ...fresh(now), computedAt: now - 61000 })],
  ['invalid', '{'],
]) for (const explicit of [undefined, '3']) {
  test(`dispatcher uses ${explicit ? 'environment' : 'file'} fixed capacity when publication is ${name}`, async t => {
    const f = await fixture(t, { fixed: 1, explicit, record });
    f.add('new'); await f.rounds();
    assert.equal(f.taken.find(row => row.group === 'new')?.k, explicit ? 3 : 1);
  });
}

// Same isolated factory/reader/Store boundary as above. Run for capacity lookup
// changes; no clock advance may be required to observe a newly published value.
test('running dispatcher uses newly published decreases and increases on its next admission', async t => {
  const f = await fixture(t, { record: fresh });
  assert.equal(f.router.availableCapacity(), 3);
  f.write({ ...fresh(f.now()), k: 1 }); f.add('new');
  await f.rounds();
  assert.equal(f.taken.find(row => row.group === 'new')?.k, 1);
  assert.equal(f.row(1).status, 'delivered');
  const waiting = f.add('waiting'); await f.rounds();
  assert.equal(f.row(waiting.id).status, 'pending');
  f.write(fresh(f.now())); await f.rounds();
  assert.equal(f.taken.find(row => row.group === 'waiting')?.k, 3);
  assert.equal(f.row(waiting.id).status, 'delivered');
});

// Private file, injected wall clock and real slot transaction; no live runtime.
// Run for current-time lookup changes; skip changes outside capacity admission.
test('dispatcher reads new publication after the clock moves backward', async t => {
  const f = await fixture(t, { record: fresh });
  assert.equal(f.router.availableCapacity(), 3);
  f.advance(-3600000);
  f.write({ ...fresh(f.now()), k: 1 }); f.add('new');
  await f.rounds();
  assert.equal(f.taken.find(row => row.group === 'new')?.k, 1);
  assert.equal(f.row(1).status, 'delivered');
});

test('stopped publisher preserves delivery and admits below fallback while queuing at its limit', async t => {
  const f = await fixture(t, { record: now => ({ ...fresh(now), computedAt: now - 61000 }) });
  f.put('existing'); const existing = f.add('existing'), admitted = f.add('below'), queued = f.add('waiting');
  await f.rounds(5);
  assert.equal(f.row(existing.id).status, 'delivered');
  assert.equal(f.row(admitted.id).status, 'delivered');
  assert.equal(f.taken.find(row => row.group === 'below')?.k, 2);
  assert.equal(f.row(queued.id).status, 'pending');
  f.write(fresh(f.now())); await f.rounds(5);
  assert.equal(f.taken.find(row => row.group === 'waiting')?.k, 3);
  assert.equal(f.row(queued.id).status, 'delivered');
});

// Retain the last successful file/record while publication does not advance.
// Same private reader/Store fixture, no publisher write injection. Run for
// freshness lookup changes; crossing the expiry boundary must take effect now.
test('dispatcher and supervisor record expire together between adjacent reads', async t => {
  const f = await fixture(t, { record: fresh });
  const published = fresh(f.now());
  f.advance(59900);
  assert.equal(f.router.availableCapacity(), 3);
  assert.equal(f.router.availableCapacity(), f.m4(published));
  f.advance(200); f.add('new'); await f.rounds();
  const k = f.taken.find(row => row.group === 'new')?.k;
  assert.equal(k, 2); assert.equal(k, f.m4(published));
});

test('single activation never reads pool capacity', async t => {
  const f = await fixture(t, { mode: 'single', record: '{' });
  await f.rounds();
  // Satisfy resident absence pacing before checking the single-session launch.
  f.advance(5000); await f.rounds();
  assert.ok(f.calls.some(row => row[0] === 'launch' && row[1].sessionGroup === null));
  assert.equal(f.taken.length, 0); assert.equal(f.reads(), 0);
});

test('held continuation takes over above a lowered limit using the current capacity', async t => {
  const f = await fixture(t, { record: fresh });
  f.put('existing');
  f.db.takeSlot('held', { runId: 'old-held', k: 3 });
  f.db.recordRunEnd('held', { runId: 'old-held', reason: 'upgrade' });
  await f.rounds();
  const waiting = f.add('waiting');
  f.write({ ...fresh(f.now()), k: 1 });
  // Satisfy continuation restart pacing after observing the held run absent.
  f.advance(5000);
  await f.rounds(6);
  assert.equal(f.taken.filter(row => row.group === 'held' && row.k !== 100000).at(-1)?.k, 1);
  assert.ok(f.calls.some(row => row[0] === 'launch' && row[1].sessionGroup === 'held'));
  assert.equal(f.db.listSlotOccupancy().length, 2);
  assert.equal(f.row(waiting.id).status, 'pending');
});

test('scheduler requires a capacity function', t => {
  const f = routerFixture(t);
  f.options.poolSize = 2;
  assert.throws(() => f.create(), /poolSize must be a function/);
});
