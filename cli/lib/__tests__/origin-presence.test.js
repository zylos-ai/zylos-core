import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { guardDatabase } from '../../../skills/comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../../skills/comm-bridge/scripts/c4-schema.js';
import { createStore } from '../../../skills/comm-bridge/scripts/c4-v2-store.js';
import { openReadStore } from '../c4-read-store.js';
import { readOriginFacts, describeOrigin } from '../origin-presence.js';

const base = { view: 'multi', origin: { presence: 'not_running' },
  originNeed: { inbound: 1, controls: 0, oldestAt: 600 }, runtimeHealth: {}, targetRuntime: 'codex', nowSec: 1000 };
for (const [name, input, state, failure] of [
  ['single absence', { view: 'single' }, 'not_running', false],
  ['single ignores need and auth', { view: 'single', runtimeHealth: { codex: { health: 'auth_failed' } } }, 'not_running', false],
  ['running survives an unreadable need', { origin: { presence: 'running' }, originNeed: { error: { message: 'locked' } } }, 'running', false],
  ['starting survives an unreadable need', { origin: { presence: 'starting' }, originNeed: { error: { message: 'locked' } } }, 'starting', false],
  ['unknown presence stays unknown', { origin: { presence: 'unknown' } }, 'unknown', false],
  ['present work waits for target authentication', { origin: { presence: 'running' }, runtimeHealth: { codex: { health: 'auth_failed' } } }, 'auth_wait', true],
  ['absent work waits for target authentication', { runtimeHealth: { codex: { health: 'auth_failed' } } }, 'auth_wait', true],
  ['unreadable absent need fails', { originNeed: { error: { message: 'locked' } } }, 'need_unreadable', true],
  ['no need sleeps even with failed auth', { originNeed: { inbound: 0, controls: 0, oldestAt: null }, runtimeHealth: { codex: { health: 'auth_failed' } } }, 'sleeping', false],
  ['ready control wakes', { originNeed: { inbound: 0, controls: 1, oldestAt: 701 } }, 'waking', false],
  ['demand at 299 seconds wakes', { originNeed: { inbound: 1, controls: 0, oldestAt: 701 } }, 'waking', false],
  ['demand at 300 seconds is overdue', { originNeed: { inbound: 1, controls: 0, oldestAt: 700 } }, 'wake_overdue', true],
  ['rate limit precedes overdue', { runtimeHealth: { codex: { health: 'rate_limited' } } }, 'rate_wait', false],
  ['present rate limit preserves presence', { origin: { presence: 'running' }, runtimeHealth: { codex: { health: 'rate_limited' } } }, 'running', false],
  ['missing target ignores unrelated auth', { targetRuntime: null, runtimeHealth: { codex: { health: 'auth_failed' } } }, 'wake_overdue', true],
  ['unavailable health keeps time based wake decision', { runtimeHealth: { codex: { health: 'unavailable' } } }, 'wake_overdue', true],
]) test(name, () => assert.deepEqual(describeOrigin({ ...base, ...input }), { state, failure }));

// Covers the shared CLI/Dashboard reader against a temporary C4 database. Run
// when its connection or queries change; skip for presentation-only changes.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME; no tmux or service runs.
test('shared reader opens only the supplied C4 read-only, preserving bytes and rows', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-facts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const filename = path.join(root, 'comm-bridge', 'c4.db');
  const db = new Database(filename); guardDatabase(db, schema);
  const store = createStore(db, { now: () => 1_000_000 });
  store.insertControl('due', { sessionGroup: 'origin', availableAt: 1100, appendAckSuffix: false });
  store.insertControl('future', { sessionGroup: 'origin', availableAt: 1200, appendAckSuffix: false });
  store.setDrainFence('*', { reason: 'manual_restart', runId: 'restart' });
  db.close();
  const before = fs.readFileSync(filename);
  const opened = await openReadStore(root);
  assert.throws(() => opened.store.insertControl('forbidden', { sessionGroup: 'origin', appendAckSuffix: false }), error => error.code === 'DB_WRITE_FAILED' && /readonly/i.test(error.message));
  opened.close();
  assert.deepEqual(await readOriginFacts({ zylosDir: root, nowSec: 1099 }), { originNeed: { inbound: 0, controls: 0, continuation: false, oldestAt: null }, transitionOpen: false, fenced: true });
  assert.deepEqual(await readOriginFacts({ zylosDir: root, nowSec: 1100 }), { originNeed: { inbound: 0, controls: 1, continuation: false, oldestAt: 1100 }, transitionOpen: false, fenced: true });
  assert.deepEqual(fs.readFileSync(filename), before);
  const missing = await readOriginFacts({ zylosDir: path.join(root, 'missing'), nowSec: 1100 });
  assert.equal(missing.originNeed.error.code, 'READ_FAILED');
  assert.equal(fs.existsSync(path.join(root, 'missing')), false);
});
