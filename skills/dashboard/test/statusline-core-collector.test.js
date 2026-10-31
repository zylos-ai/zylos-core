import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StatuslineCollector } from '../src/lib/collectors/statusline-collector.js';
import { createSessionReader } from '../../../cli/lib/session-state-reader-async.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-core-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const groupDir = path.join(root, 'activity-monitor/session-groups/origin');
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'activity-monitor/statusline.json'), JSON.stringify({ session_id: 'legacy', context_window: { used_percentage: 99 } }));
  const identity = { present: true, ready: true, runtime: 'claude', runId: 'run1', sessionId: 'session1', createdAt: 1, serverGeneration: 'g1', tmuxSessionId: '$1', paneId: '%1' };
  const rows = [], health = [];
  const store = { insertMetric: row => rows.push(row), upsertSourceHealth: (...args) => health.push(args) };
  const sample = { session_id: 'session1', zylos: { v: 1, runId: 'run1', capturedAt: Date.now() }, context_window: { used_percentage: 35 }, model: { id: 'model1' } };
  const write = () => fs.writeFileSync(path.join(groupDir, 'statusline.json'), JSON.stringify(sample));
  let readIdentity = () => ({ ...identity });
  const reader = createSessionReader({ env: { ZYLOS_DIR: root }, open: async () => ({ close: async () => {} }), observe: async () => readIdentity() });
  const collector = new StatuslineCollector(store, { zylosDir: root }, { read: () => reader.readSessionState('origin', { freshnessMs: 5000 }) });
  return { root, groupDir, identity, rows, health, sample, write, collector, setObserver: fn => { readIdentity = fn; } };
}

test('Core usage is accepted independently of missing status, legacy global file is ignored, repeated sample is deduplicated', async t => {
  const f = fixture(t); f.write();
  assert.equal((await f.collector.collect()).written, 1);
  await f.collector.collect();
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].session_id, 'session1');
  assert.equal(f.rows[0].dimensions.context_pct, 35);
  assert.equal(f.rows[0].dimensions.run_id, 'run1');
  assert.equal(f.rows[0].timestamp, new Date(f.sample.zylos.capturedAt).toISOString());
  assert.equal(f.collector.getRuntimeInfo().model_id, 'model1');
});

for (const reason of ['missing', 'identity_mismatch', 'stale', 'identity_changed', 'not_running', 'starting']) test(`Core ${reason} usage never falls back to the global sample or cached runtime info`, async t => {
  const f = fixture(t); f.write(); await f.collector.collect();
  if (reason === 'missing') fs.unlinkSync(path.join(f.groupDir, 'statusline.json'));
  if (reason === 'identity_mismatch') { f.sample.zylos.runId = 'old-run'; f.write(); }
  if (reason === 'stale') { f.sample.zylos.capturedAt = Date.now() - 10000; f.write(); }
  if (reason === 'identity_changed') { let calls = 0; f.setObserver(() => ({ ...f.identity, runId: ++calls % 2 === 0 ? 'changed' : 'run1' })); }
  if (reason === 'not_running') f.identity.present = false;
  if (reason === 'starting') f.identity.ready = false;
  assert.equal((await f.collector.collect()).written, 0);
  assert.equal(f.rows.length, 1);
  assert.equal(f.collector.getRuntimeInfo(), null);
  assert.equal(f.health.at(-1)[3].reason, reason);
});

test('same-valued usage in a new live run is recorded with its new identity', async t => {
  const f = fixture(t); f.write(); await f.collector.collect();
  f.identity.runId = f.sample.zylos.runId = 'run2';
  f.identity.sessionId = f.sample.session_id = 'session2'; f.write();
  await f.collector.collect();
  assert.equal(f.rows.length, 2);
  assert.equal(f.rows[1].session_id, 'session2');
  assert.equal(f.rows[1].dimensions.run_id, 'run2');
});

test('Core reader selects live Codex rollout instead of Claude/global statusline data', async t => {
  const f = fixture(t); f.write(); f.identity.runtime = 'codex';
  const rollout = path.join(f.root, 'rollout.jsonl');
  fs.writeFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 40 }, model_context_window: 200 }, rate_limits: { primary: { window_minutes: 300, used_percent: 20, resets_at: 123 } } } }) + '\n');
  fs.writeFileSync(path.join(f.groupDir, 'events.jsonl'), JSON.stringify({ v: 1, ts: Date.now(), event: 'session_start', runtime: 'codex', session_group: 'origin', run_id: 'run1', session_id: 'session1', transcript_path: rollout }) + '\n');
  await f.collector.collect();
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].runtime, 'codex');
  assert.equal(f.rows[0].dimensions.context_pct, 20);
  assert.equal(f.rows[0].dimensions.rate_limit, undefined);
  assert.equal(f.collector.getRuntimeInfo(), null);
});

test('default loader follows Core mode for single and multi observations rather than Dashboard baseline runtime', async t => {
  const f = fixture(t);
  const pkg = path.join(f.root, 'package');
  fs.mkdirSync(path.join(pkg, 'cli/lib'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(pkg, 'cli/lib/config.js'), 'export const state={mode:"single"};export function readSessionMode(){return state;}');
  fs.writeFileSync(path.join(pkg, 'cli/lib/session-state-reader.js'), `export const calls=[],accountCalls=[];export const state={runtime:'claude'};export async function readSessionState(group, options){calls.push({group,options});return {identity:{present:true,runtime:state.runtime},usage:{valid:false,reason:'missing'}};}export async function readAccountUsage(runtime){accountCalls.push(runtime);return {sample:runtime};}`);
  const prior = process.env.ZYLOS_PACKAGE_ROOT;
  process.env.ZYLOS_PACKAGE_ROOT = pkg;
  t.after(() => { if (prior === undefined) delete process.env.ZYLOS_PACKAGE_ROOT; else process.env.ZYLOS_PACKAGE_ROOT = prior; });
  const collector = new StatuslineCollector({ insertMetric() { assert.fail('no live usage'); }, upsertSourceHealth() {} }, { zylosDir: f.root, runtime: 'codex' });
  const config = await import(path.join(pkg, 'cli/lib/config.js'));
  const reader = await import(path.join(pkg, 'cli/lib/session-state-reader.js'));
  await collector.collect();
  assert.deepEqual(collector.getAccountUsage(), { runtime: 'claude', value: { sample: 'claude' } });
  config.state.mode = 'multi';
  reader.state.runtime = 'codex';
  await collector.collect();
  assert.deepEqual(reader.accountCalls, ['claude', 'codex']);
  assert.deepEqual(collector.getAccountUsage(), { runtime: 'codex', value: { sample: 'codex' } });
  assert.deepEqual(reader.calls, [{ group: null, options: { freshnessMs: 5000 } }, { group: 'origin', options: { freshnessMs: 5000 } }]);
});

test('stop waits for an in-flight Core read before the caller closes the store', async () => {
  let release, finished = false;
  const collector = new StatuslineCollector({ upsertSourceHealth() { finished = true; } }, {}, {
    read: () => new Promise(resolve => { release = resolve; })
  });
  const pending = collector.collect();
  let stopped = false;
  const stop = collector.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release({ usage: { valid: false, reason: 'not_running' } });
  await stop;
  await pending;
  assert.equal(finished, true);
});

test('transient invalid read preserves dedup and valid recovery restores runtime and liveness', async t => {
  const f = fixture(t); f.write();
  await f.collector.collect();
  f.setObserver(() => { throw new Error('temporary read failure'); });
  await f.collector.collect();
  assert.equal(f.collector.getRuntimeInfo(), null);
  assert.equal(f.health.at(-1)[2], 'stale');
  f.setObserver(() => ({ ...f.identity }));
  assert.equal((await f.collector.collect()).written, 0);
  assert.equal(f.rows.length, 1);
  assert.equal(f.collector.getRuntimeInfo().model_id, 'model1');
  assert.equal(f.health.at(-1)[2], 'healthy');
});

test('real Core reader selects newest other-session account sample without attributing it to Origin', async t => {
  const f = fixture(t);
  const otherDir = path.join(f.root, 'activity-monitor/session-groups/other');
  fs.mkdirSync(otherDir, { recursive: true });
  f.sample.rate_limits = { five_hour: { used_percentage: 10 } };
  f.write();
  const other = { ...f.sample, session_id: 'session-other', zylos: { ...f.sample.zylos, runId: 'run-other' }, rate_limits: { five_hour: { used_percentage: 75 }, seven_day: { used_percentage: 25 } } };
  const otherFile = path.join(otherDir, 'statusline.json');
  fs.writeFileSync(otherFile, JSON.stringify(other));
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(f.groupDir, 'statusline.json'), now - 10, now - 10);
  fs.utimesSync(otherFile, now, now);
  const reader = createSessionReader({ env: { ZYLOS_DIR: f.root },
    open: async () => ({ close: async () => {} }),
    observe: async ({ sessionGroup }) => ({ ...f.identity, ...(sessionGroup === 'other' ? { runId: 'run-other', sessionId: 'session-other' } : {}) }),
    listSessions: async () => [{ sessionGroup: 'origin' }, { sessionGroup: 'other' }]
  });
  const collector = new StatuslineCollector({ insertMetric: row => f.rows.push(row), upsertSourceHealth() {} }, {}, {
    read: async () => ({ ...await reader.readSessionState('origin', { freshnessMs: 5000 }), accountUsage: { runtime: 'claude', value: await reader.readAccountUsage('claude') } })
  });
  await collector.collect();
  assert.equal(f.rows[0].session_id, 'session1');
  assert.equal(f.rows[0].dimensions.context_pct, 35);
  assert.equal(f.rows[0].dimensions.rate_limit, undefined);
  assert.deepEqual(collector.getAccountUsage(), { runtime: 'claude', value: other.rate_limits });
  other.rate_limits.five_hour.used_percentage = 80;
  fs.writeFileSync(otherFile, JSON.stringify(other));
  await collector.collect();
  assert.equal(collector.getAccountUsage().value.five_hour.used_percentage, 80);
  assert.equal(f.rows.length, 1, 'account refresh does not duplicate session sample');
  delete other.rate_limits; delete f.sample.rate_limits;
  fs.writeFileSync(otherFile, JSON.stringify(other)); f.write();
  await collector.collect();
  assert.deepEqual(collector.getAccountUsage(), { runtime: 'claude', value: null });
});

for (const failure of [false, true]) test(`Core package resolution ${failure ? 'retries after failure cooldown' : 'stays cached after success'} across collectors`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const lib = path.join(f.root, 'core', 'cli', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(f.root, 'core', 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(lib, 'config.js'), 'export function readSessionMode(){return {mode:"multi"}}');
  fs.writeFileSync(path.join(lib, 'session-state-reader.js'), `export async function readSessionState(){return {identity:{runtime:'claude'},usage:{valid:false,reason:'missing'}}} export async function readAccountUsage(){return {five_hour:{used_percentage:42}}}`);
  let calls = 0, unavailable = failure;
  t.mock.module('../../comm-bridge/scripts/core-config-loader.js', { namedExports: {
    resolveCoreConfigModule() { calls++; if (unavailable) throw new Error('unavailable'); return path.join(lib, 'config.js'); }
  } });
  const { StatuslineCollector: Collector } = await import(`../src/lib/collectors/statusline-collector.js?cache-test=${failure}`);
  const store = { upsertSourceHealth() {} };
  const a = new Collector(store, {}), b = new Collector(store, {});
  await a.collect(); await a.collect(); await b.collect();
  assert.equal(calls, 1);
  assert.deepEqual(b.getAccountUsage(), failure ? null : { runtime: 'claude', value: { five_hour: { used_percentage: 42 } } });
  unavailable = false;
  t.mock.timers.tick(59999);
  await a.collect();
  assert.equal(calls, 1, 'no repeated package search during cooldown');
  t.mock.timers.tick(1);
  await a.collect(); await b.collect();
  assert.equal(calls, failure ? 2 : 1);
  assert.deepEqual(a.getAccountUsage(), { runtime: 'claude', value: { five_hour: { used_percentage: 42 } } });
  t.mock.timers.tick(60000);
  await b.collect();
  assert.equal(calls, failure ? 2 : 1, 'successful resolution remains cached');
});

test('polling reads every two seconds and clears account usage when the next read fails', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const collector = new StatuslineCollector({ upsertSourceHealth() {} }, {}, {
    read: () => {
      if (++calls > 1) throw new Error('unavailable');
      return { usage: { valid: false, reason: 'missing' }, accountUsage: { runtime: 'claude', value: { five_hour: { used_percentage: 42 } } } };
    }
  });
  t.after(() => collector.stop());
  collector.start();
  t.mock.timers.tick(1999);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  await collector.collect();
  assert.equal(calls, 1);
  assert.equal(collector.getAccountUsage().value.five_hour.used_percentage, 42);
  t.mock.timers.tick(2000);
  await collector.collect();
  assert.equal(calls, 2);
  assert.equal(collector.getAccountUsage(), null);
  await collector.stop();
  t.mock.timers.tick(2000);
  assert.equal(calls, 2, 'stop removes the polling timer');
});

test('unchanged sample values remain distinct across runtime, run and session identities', async () => {
  const rows = [];
  const identity = { runtime: 'claude', runId: 'run-one', sessionId: 'session-one' };
  const usage = { valid: true, sampledAt: 1000, value: { context_window: { used_percentage: 35 } } };
  const collector = new StatuslineCollector({ insertMetric: row => rows.push(row), upsertSourceHealth() {} }, {}, {
    read: async () => ({ identity: { ...identity }, usage }),
  });
  assert.equal((await collector.collect()).written, 1);
  assert.equal((await collector.collect()).written, 0);
  identity.runId = 'run-two';
  assert.equal((await collector.collect()).written, 1);
  identity.sessionId = 'session-two';
  assert.equal((await collector.collect()).written, 1);
  identity.runtime = 'codex';
  assert.equal((await collector.collect()).written, 1);
  assert.deepEqual(rows.map(row => [row.runtime, row.dimensions.run_id, row.session_id]), [
    ['claude', 'run-one', 'session-one'], ['claude', 'run-two', 'session-one'],
    ['claude', 'run-two', 'session-two'], ['codex', 'run-two', 'session-two'],
  ]);
  assert.equal((await collector.collect()).written, 0);
  await collector.stop();
});
