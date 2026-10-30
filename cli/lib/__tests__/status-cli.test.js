import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectStatus } from '../status-view.js';
import { showStatus } from '../../commands/service.js';
import { collectHostStatus } from '../../commands/service.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const absent = { identity: { present: false }, status: { valid: false, reason: 'not_running', sampledAt: null } };
const live = (ready = true, reason = null) => ({ identity: { present: true, ready, runtime: 'codex', runId: 'run', sessionId: ready ? 'session' : null },
  status: { valid: ready && !reason, reason, sampledAt: reason === 'starting' ? null : 1000, value: { state: 'idle', idle_seconds: 4 } } });
const fixture = (overrides = {}) => ({ mode: () => ({ mode: 'multi' }), list: async () => [{ sessionGroup: 'b' }, { sessionGroup: 'a' }, { sessionGroup: 'origin' }],
  session: async () => live(), health: () => ({ missing: true }), now: () => 2000, resolveRoot: () => {}, ...overrides });

test('review P1: real text status uses the default PM2 collector without crashing', { timeout: 10000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-text-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zylos = path.join(root, 'zylos');
  fs.mkdirSync(zylos);
  fs.writeFileSync(path.join(root, 'pm2'), `#!${process.execPath}\nif(process.argv.slice(2).join(' ')!=='jlist')process.exit(71);console.log(JSON.stringify([{name:'fixture-scheduler',pm2_env:{status:'online'}}]));\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [new URL('../../zylos.js', import.meta.url).pathname, 'status'], {
    env: { HOME: root, ZYLOS_DIR: zylos, PATH: root, NO_COLOR: '1' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session mode: single/);
  assert.match(result.stdout, /fixture-scheduler: online/);
  assert.match(result.stdout, /Disk: \d+ GiB available \/ \d+ GiB total/);
  assert.doesNotMatch(result.stderr, /ReferenceError/);
});

test('single/null uses only null reader and preserves absent/running states', async () => {
  for (const mode of ['single', null]) {
    for (const row of [absent, live()]) {
      const calls = [];
      const view = await collectStatus(fixture({ mode: () => ({ mode }), session: (group, options) => { calls.push([group, options]); return row; },
        list: () => { throw new Error('single must not list'); } }));
      assert.equal(view.view, 'single'); assert.deepEqual(calls, [[null, { freshnessMs: 5000 }]]); assert.deepEqual(view.groups, []);
      assert.equal(view.origin.presence, row.identity.present ? 'running' : 'not_running');
      if (!row.identity.present) assert.equal(view.origin.runtime, null);
    }
  }
});

test('review P2: text status retains PM2 and disk while JSON never queries host extras', async () => {
  const original = console.log, previousExit = process.exitCode;
  const lines = []; console.log = line => lines.push(line);
  try {
    const host = () => collectHostStatus({ exec: () => JSON.stringify([{ name: 'scheduler', pm2_env: { status: 'online' } }]),
      disk: () => ({ blocks: 20, bavail: 10, bsize: 1024 ** 3 }) });
    await showStatus([], { collect: () => collectStatus(fixture()), host });
    assert.match(lines.join('\n'), /scheduler: online/);
    assert.match(lines.join('\n'), /Disk: 10 GiB available \/ 20 GiB total/);
    lines.length = 0;
    await showStatus(['--json'], { collect: () => collectStatus(fixture()), host: () => assert.fail('JSON must retain  only') });
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).ok, true);
  } finally { console.log = original; process.exitCode = previousExit; }
});

test('multi sort/starting/stale/generation reasons are reader projections', async () => {
  for (const reason of ['starting', 'stale', 'identity_changed']) {
    const view = await collectStatus(fixture({ session: async group => group === 'b' ? live(reason !== 'starting', reason) : live() }));
    assert.deepEqual(view.groups.map(group => group.sessionGroup), ['a', 'b']);
    assert.equal(view.groups[1].presence, reason === 'starting' ? 'starting' : 'running');
    assert.equal(view.groups[1].status.valid, false); assert.equal(view.groups[1].status.reason, reason);
    assert.equal(view.groups[1].status.state, null); assert.equal(view.groups[1].status.idleSeconds, null);
  }
});

test('local failures remain in the successful projection including F10 missing/invalid', async () => {
  const view = await collectStatus(fixture({ mode: () => { throw new Error('bad F1'); },
    session: async group => { if (group === 'b') throw new Error('bad item'); return live(); },
    health: runtime => runtime === 'claude' ? { health: 'rate_limited', publicHealth: 'rate_limited', cooldownUntil: 4, updatedAt: 5 } : { unreadable: true },
  }));
  assert.equal(view.sessionMode, 'unreadable'); assert.equal(view.view, 'multi');
  assert.equal(view.groups[1].presence, 'unknown'); assert.equal(view.groups[1].error.code, 'READ_FAILED');
  assert.equal(view.runtimeHealth.claude.health, 'rate_limited'); assert.equal(view.runtimeHealth.codex.health, null);
  const noList = await collectStatus(fixture({ list: () => { throw new Error('bad list'); } }));
  assert.equal(noList.groupListError.code, 'READ_FAILED'); assert.deepEqual(noList.groups, []);
  assert.deepEqual(noList.runtimeHealth.codex, { source: 'missing', health: 'ok', publicHealth: 'ok', cooldownUntil: null, updatedAt: null });
});

test('CLI emits one JSON line for invalid args, reader load failure, and success', async () => {
  const log = console.log, previousExit = process.exitCode;
  const lines = []; console.log = line => lines.push(line);
  try {
    for (const [args, deps, code] of [
      [['--json', '--bad'], {}, 'INVALID_ARGUMENT'],
      [['--json'], { load: async () => { throw new Error('module unavailable'); } }, 'STATUS_UNAVAILABLE'],
      [['--json'], { collect: () => collectStatus(fixture()) }, null],
    ]) {
      lines.length = 0; process.exitCode = 0;
      const result = await showStatus(args, deps);
      assert.equal(lines.length, 1); assert.deepEqual(JSON.parse(lines[0]), result);
      assert.equal(process.exitCode, code ? 1 : 0);
      if (code) { assert.equal(result.error.code, code); assert.deepEqual(result.error.persisted, []); assert.equal('data' in result, false); }
    }
  } finally { console.log = log; process.exitCode = previousExit; }
});
