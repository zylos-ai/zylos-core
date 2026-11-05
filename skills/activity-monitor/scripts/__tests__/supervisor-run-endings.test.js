import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SupervisorRunEndings } from '../supervisor-run-endings.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'run-ends-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = { root, now: 2_000_000, rows: new Map(), records: [], alerts: [], errors: [], fresh: [], reads: 0, writes: 0,
    context: { configuration: { mode: 'multi' }, transition: null, fences: [], scenes: [] }, lastDone: null };
  f.db = { getModeTransition: () => f.context.transition, listDrainFences: () => f.context.fences, listRunEndings: () => [...f.rows.values()], getLastCompletedModeTransition: () => f.lastDone,
    recordRunEnd: (group, options) => { f.writes++; f.records.push({ group, ...options }); f.rows.set(group, { sessionGroup: group, runId: options.runId, reason: options.reason, endedAt: Math.floor(f.now / 1000) }); return { recorded: true }; } };
  f.deps = { db: f.db, env: { ZYLOS_DIR: root }, now: () => f.now,
    readIdentity: group => { f.fresh.push(group); return { present: false }; },
    readFile: async (...args) => { f.reads++; return fs.readFile(...args); },
    alert: event => f.alerts.push(event), reportError: error => f.errors.push(error) };
  f.service = new SupervisorRunEndings(f.deps);
  f.write = async (group = 'test:a', runId = 'r1', ts = f.now - 1000) => {
    const dir = path.join(root, 'activity-monitor', 'session-groups', group); await fs.mkdir(dir, { recursive: true });
    const temporary = path.join(dir, 'current-session.new');
    await fs.writeFile(temporary, JSON.stringify({ runId, ts }));
    await fs.rename(temporary, path.join(dir, 'current-session.json'));
  };
  return f;
}

test('first reconciliation after restart records a missing run once and caches unchanged current-session files', async t => {
  const f = await fixture(t); await f.write(); await f.write('origin');
  await f.service.advance(f.context);
  assert.deepEqual(f.records.map(row => row.group), ['origin', 'test:a']);
  assert.ok(f.records.every(row => row.reason === 'unexpected'));
  const reads = f.reads, fresh = f.fresh.length;
  for (let i = 0; i < 100; i++) await f.service.advance(f.context);
  assert.equal(f.reads, reads); assert.equal(f.fresh.length, fresh); assert.equal(f.writes, 2);
  f.service = new SupervisorRunEndings(f.deps); await f.service.advance(f.context);
  assert.equal(f.reads, reads + 2); assert.equal(f.writes, 2);
});

test('reconciliation checks all gates and never turns unreadable facts into absence', async t => {
  const f = await fixture(t); await f.write();
  for (const setup of [
    () => { f.context.configuration.mode = 'single'; },
    () => { f.context.transition = { phase: 'gating' }; },
    () => { f.context.fences = [{ sessionGroup: '*' }]; },
    () => { f.context.fences = [{ sessionGroup: 'test:a' }]; },
    () => { f.context.scenes = [{ sessionGroup: 'test:a', present: true, ready: false }]; },
    () => { f.context.scenes = [{ sessionGroup: 'test:a', present: true, observationError: new Error('unknown') }]; },
    () => { f.lastDone = { target_mode: 'multi', updated_at: f.now / 1000 }; },
  ]) {
    f.context = { configuration: { mode: 'multi' }, transition: null, fences: [], scenes: [] }; f.lastDone = null;
    setup(); await f.service.advance(f.context);
  }
  assert.equal(f.writes, 0); assert.equal(f.fresh.length, 0);
  f.context = { configuration: { mode: 'multi' }, transition: null, fences: [], scenes: [] }; f.lastDone = null;
  f.deps.readIdentity = () => { throw new Error('tmux unavailable'); }; f.service = new SupervisorRunEndings(f.deps);
  await f.service.advance(f.context); assert.equal(f.writes, 0);
  const dir = path.join(f.root, 'activity-monitor/session-groups/test:a/current-session.json');
  await fs.writeFile(dir, '{'); await f.service.advance(f.context); const count = f.reads;
  await f.service.advance(f.context); assert.equal(f.reads, count); assert.equal(f.writes, 0);
  await fs.writeFile(dir, JSON.stringify({ runId: 'bad', ts: 'bad' })); await f.service.advance(f.context); assert.equal(f.writes, 0);
});

test('fresh tmux query follows current-session read and closes the snapshot-to-file race', async t => {
  const f = await fixture(t); await f.write('test:a', 'new-run');
  const order = [];
  const read = f.deps.readFile;
  f.deps.readFile = (...args) => { order.push('file'); return read(...args); };
  f.deps.readIdentity = () => { order.push('tmux'); return { present: true, runId: 'new-run' }; };
  f.service = new SupervisorRunEndings(f.deps); await f.service.advance(f.context);
  assert.deepEqual(order, ['file', 'tmux']); assert.equal(f.writes, 0);
  f.deps.readIdentity = () => ({ present: false }); f.service.readIdentity = f.deps.readIdentity;
  await f.service.advance(f.context); assert.equal(f.records[0].runId, 'new-run');
});

test('one unavailable group does not block another observable group', async t => {
  const f = await fixture(t); await f.write('test:a'); await f.write('test:b');
  f.service.readIdentity = group => { if (group === 'test:a') throw new Error('server unavailable'); return { present: false }; };
  await f.service.advance(f.context);
  assert.deepEqual(f.records.map(row => row.group), ['test:b']);
});

test('TTL records and live clear or compact sessions do not produce another ending', async t => {
  const f = await fixture(t); await f.write();
  f.rows.set('test:a', { sessionGroup: 'test:a', runId: 'r1', reason: 'ttl' });
  for (let i = 0; i < 3; i++) await f.service.advance(f.context);
  f.rows.clear(); f.context.scenes = [{ sessionGroup: 'test:a', present: true, runId: 'r1' }];
  for (let i = 0; i < 3; i++) { await f.write('test:a', 'r1', f.now + i); await f.service.advance(f.context); }
  assert.equal(f.writes, 0); assert.equal(f.fresh.length, 0);
});

test('read and per-group write failures retry and alert after sixty seconds with throttling', async t => {
  const f = await fixture(t); await f.write();
  const read = f.db.listRunEndings; f.db.listRunEndings = () => { throw Object.assign(new Error('read'), { code: 'DB_BUSY' }); };
  await f.service.advance(f.context); f.now += 59999; await f.service.advance(f.context); assert.equal(f.alerts.length, 0);
  f.now++; await f.service.advance(f.context); await Promise.resolve(); assert.equal(f.alerts.length, 1);
  f.now += 1000; await f.service.advance(f.context); assert.equal(f.alerts.length, 1); assert.equal(f.writes, 0);
  f.db.listRunEndings = read; const write = f.db.recordRunEnd;
  f.db.recordRunEnd = () => { throw new Error('write'); };
  await f.service.advance(f.context); f.now += 60000; await f.service.advance(f.context); await Promise.resolve();
  assert.equal(f.alerts.length, 2); assert.equal(f.alerts[1].session_group, 'test:a');
  f.db.recordRunEnd = write; await f.service.advance(f.context); assert.equal(f.writes, 1);
});

test('five short unexpected runs alert and long or intentional runs reset the counter', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 6; i++) { await f.write('test:a', 'r' + i); await f.service.advance(f.context); }
  await Promise.resolve(); assert.equal(f.alerts.length, 1); assert.equal(f.records.length, 6);
  assert.equal(f.service.shortRuns.get('test:a'), 6);
  await f.db.recordRunEnd('test:a', { runId: 'intent', reason: 'upgrade' });
  await f.write('test:a', 'intent'); await f.service.advance(f.context);
  assert.equal(f.service.shortRuns.has('test:a'), false);
  for (let i = 7; i <= 8; i++) { await f.write('test:a', 'r' + i); await f.service.advance(f.context); }
  assert.equal(f.service.shortRuns.get('test:a'), 2);
  await f.write('test:a', 'long', f.now - 600000); await f.service.advance(f.context);
  assert.equal(f.service.shortRuns.has('test:a'), false);
});

test('known unobservable servers skip their files while another server still reconciles', async t => {
  const f = await fixture(t); await f.write('test:a'); await f.write('test:b');
  f.service.isObservable = group => group !== 'test:a';
  await f.service.advance(f.context);
  assert.deepEqual(f.records.map(row => row.group), ['test:b']); assert.equal(f.reads, 1);
});

test('removing a failed group clears its continuous-write failure episode', async t => {
  const f = await fixture(t); await f.write();
  f.db.recordRunEnd = () => { throw new Error('write'); };
  await f.service.advance(f.context); assert.equal(f.service.failures.has('write:test:a'), true);
  await fs.rm(path.join(f.root, 'activity-monitor/session-groups/test:a'), { recursive: true });
  f.now += 120000; await f.service.advance(f.context); assert.equal(f.service.failures.has('write:test:a'), false);
  await f.write(); await f.service.advance(f.context); assert.equal(f.alerts.length, 0);
});


test('short-run alert fires on the fifth run and not before', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 4; i++) { await f.write('test:a', 'r' + i); await f.service.advance(f.context); }
  await Promise.resolve(); assert.equal(f.alerts.length, 0);
  await f.write('test:a', 'r5'); await f.service.advance(f.context);
  await Promise.resolve(); assert.equal(f.alerts.length, 1);
});

test('a persistent failure alerts again only after thirty minutes', async t => {
  const f = await fixture(t); await f.write();
  f.db.listRunEndings = () => { throw Object.assign(new Error('read'), { code: 'DB_BUSY' }); };
  await f.service.advance(f.context); f.now += 60000; await f.service.advance(f.context);
  await Promise.resolve(); assert.equal(f.alerts.length, 1);
  f.now += 1799999; await f.service.advance(f.context); await Promise.resolve(); assert.equal(f.alerts.length, 1);
  f.now += 1; await f.service.advance(f.context); await Promise.resolve(); assert.equal(f.alerts.length, 2);
});

test('an unreadable run root alerts after sixty seconds and an absent one is not a failure', async t => {
  const f = await fixture(t);
  f.service.readdir = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  await f.service.advance(f.context); assert.equal(f.alerts.length, 0);
  f.now += 60000; await f.service.advance(f.context); await Promise.resolve(); assert.equal(f.alerts.length, 1);
  f.service.readdir = async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
  const errors = f.errors.length;
  await f.service.advance(f.context); assert.equal(f.service.failures.size, 0); assert.equal(f.errors.length, errors);
  f.now += 3600000; await f.service.advance(f.context); await Promise.resolve(); assert.equal(f.alerts.length, 1);
});
