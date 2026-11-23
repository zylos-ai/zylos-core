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
