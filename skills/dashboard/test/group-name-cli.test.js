import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/lib/store.js';
import { createDisplayNames } from '../src/lib/workbench/display-names.js';
import { runGroupName } from '../scripts/group-name.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-name-'));
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const zylos = path.join(root, 'zylos'); fs.mkdirSync(zylos);
  const file = path.join(data, 'dashboard.db'), store = new Store(file);
  store.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { file, env: { ...process.env, HOME: home, ZYLOS_DIR: zylos, ZYLOS_DATA_DIR: data, PM2_HOME: path.join(root, 'pm2') }, zylos };
}

// CLI integration: actual bounded Node child and private SQLite; run for argument,
// persistence or command-entry changes, skip rendering-only edits. Test runner
// supplies isolated HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; fixture overrides remain
// under owned root. No Core/PM2/tmux/network, child timeout 5s, no background loop.
test('group name command persists agent names with exact JSON success and error envelopes', t => {
  const f = fixture(t), invoke = args => spawnSync(process.execPath, [new URL('../scripts/group-name.js', import.meta.url).pathname, ...args],
    { env: f.env, encoding: 'utf8', timeout: 5000 });
  let result = invoke(['set', 'telegram:a', '  产品周会  ', '--json']);
  assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout), { ok: true, data: { sessionGroup: 'telegram:a', displayName: '产品周会', source: 'agent' } });
  result = invoke(['get', 'telegram:a', '--json']); assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).data.displayName, '产品周会');
  const store = new Store(f.file); createDisplayNames({ store }).setName('telegram:a', 'human', 'human'); store.close();
  for (const args of [['set', 'telegram:a', 'agent'], ['clear', 'telegram:a']]) {
    result = invoke([...args, '--json']); assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'NAME_SET_BY_HUMAN'); assert.match(result.stderr, /Error \[NAME_SET_BY_HUMAN\]/);
  }
  for (const args of [['list', '--active', '3x'], ['list', '--active', '0d'], ['unknown']]) {
    result = invoke([...args, '--json']); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGS');
  }
  result = invoke(['set', 'origin', 'x', '--json']); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).error.code, 'KEY_INVALID');
});

// CLI collection integration: real command dispatcher, Store and name service;
// only Core executor is injected, never a real C4 child. Owned DB and no network,
// handles close in runGroupName finally; fixture cleanup registered before work.
test('list chooses exact active and full Core shapes and redacts unnamed group previews', async t => {
  const f = fixture(t), calls = [], secret = 'sk-123456789012345678901234';
  const initial = new Store(f.file); createDisplayNames({ store: initial }).setName('telegram:named', 'named', 'human'); initial.close();
  const rows = ['origin', 'telegram:named', 'telegram:unnamed'].map(sessionGroup => ({ sessionGroup, componentName: 'telegram', lastActivityAt: 3, preview: { text: secret, timestamp: 2 } }));
  const invoke = async args => {
    let stdout = '', stderr = '';
    const code = await runGroupName(args, { env: f.env, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
      createNames: options => createDisplayNames({ ...options, now: () => 1800000000000, runC4Db: async argv => {
        calls.push(argv); return { ok: true, data: argv.includes('--active-since') ? { groups: rows, hasOlder: false } : rows };
      } }) });
    return { code, stdout, stderr, value: JSON.parse(stdout) };
  };
  const active = await invoke(['list', '--unnamed', '--active', '3d', '--json']);
  assert.equal(active.code, 0); assert.deepEqual(calls[0], ['groups', '--active-since', String(1800000000000 - 3 * 86400000), '--json']);
  assert.deepEqual(active.value.data.map(r => r.sessionGroup), ['telegram:unnamed']);
  assert.equal(active.value.data[0].fallbackName, 'Telegram · unnamed');
  assert.equal(active.stdout.includes(secret), false); assert.match(active.value.data[0].preview.text, /REDACTED/);
  assert.ok(active.value.data[0].preview.text.length <= 80);
  assert.equal((await invoke(['list', '--json'])).value.data.length, 2);
  assert.deepEqual(calls[1], ['groups', '--json']);
  const hours = await invoke(['list', '--active', '2h', '--json']); assert.equal(hours.code, 0);
  assert.deepEqual(calls[2], ['groups', '--active-since', String(1800000000000 - 2 * 3600000), '--json']);
});
test('failed Core collection has one failure envelope and no partial results; absent database fails', async t => {
  const f = fixture(t); let stdout = '', stderr = '';
  const options = { env: f.env, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
    createNames: options => createDisplayNames({ ...options, runC4Db: async () => ({ ok: false, reason: 'c4_groups_failed' }) }) };
  assert.equal(await runGroupName(['list', '--json'], options), 1);
  const value = JSON.parse(stdout); assert.equal(value.ok, false); assert.equal(value.error.code, 'C4_GROUPS_FAILED'); assert.equal('data' in value, false);
  assert.match(stderr, /Error \[C4_GROUPS_FAILED\]/);
  for (const [args, data] of [
    [['list', '--json'], null],
    [['list', '--active', '3d', '--json'], { groups: null }],
  ]) {
    stdout = ''; stderr = '';
    assert.equal(await runGroupName(args, { ...options,
      createNames: options => createDisplayNames({ ...options, runC4Db: async () => ({ ok: true, data }) }),
    }), 1);
    const malformed = JSON.parse(stdout);
    assert.equal(malformed.error.code, 'C4_GROUPS_FAILED'); assert.equal('data' in malformed, false);
    assert.match(stderr, /Error \[C4_GROUPS_FAILED\]/);
  }
  stdout = ''; stderr = '';
  assert.equal(await runGroupName(['get', 'telegram:a', '--json'], { ...options, env: { ...f.env, ZYLOS_DATA_DIR: path.join(f.zylos, 'missing') } }), 1);
  assert.equal(JSON.parse(stdout).error.code, 'DATABASE_NOT_FOUND');
});

// Actual CLI -> Core read adapter integration. The Core command path is an owned
// fixture module copied under temporary ZYLOS_DIR, never the live C4 script. Run
// for subprocess argv/env or CLI list changes; skip rendering-only edits. Both
// Node children are bounded (CLI5s, product read15s), no background processes,
// tmux/PM2/network; all files stay beneath fixture root and are removed afterward.
test('CLI list launches the bounded Core adapter with isolated root and without inherited group identity', t => {
  const f = fixture(t), dir = path.join(f.zylos, '.claude/skills/comm-bridge/scripts'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.copyFileSync(new URL('./fixtures/group-name-c4.js', import.meta.url), path.join(dir, 'c4-db.js'));
  const record = path.join(f.zylos, 'record.json'), rowsFile = path.join(f.zylos, 'rows.json');
  const secret = 'sk-123456789012345678901234';
  fs.writeFileSync(rowsFile, JSON.stringify(['origin', 'telegram:named', 'telegram:unnamed'].map(sessionGroup => ({ sessionGroup, componentName: 'telegram', lastActivityAt: 1, preview: { text: secret } }))));
  const store = new Store(f.file); createDisplayNames({ store }).setName('telegram:named', 'human', 'human'); store.close();
  const env = { ...f.env, ZYLOS_SESSION_GROUP: 'telegram:inherited', GROUP_NAME_FIXTURE_RECORD: record, GROUP_NAME_FIXTURE_ROWS: rowsFile };
  const invoke = (args, extra = {}) => spawnSync(process.execPath, [new URL('../scripts/group-name.js', import.meta.url).pathname, ...args],
    { env: { ...env, ...extra }, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  const before = Date.now() - 3 * 86400000;
  let result = invoke(['list', '--unnamed', '--active', '3d', '--json']);
  const after = Date.now() - 3 * 86400000;
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data.map(row => row.sessionGroup), ['telegram:unnamed']);
  assert.equal(result.stdout.includes(secret), false);
  let observation = JSON.parse(fs.readFileSync(record));
  assert.equal(observation.root, f.zylos); assert.equal(observation.inheritedGroup, null);
  assert.deepEqual([observation.args[0], observation.args[1], observation.args[3]], ['groups', '--active-since', '--json']);
  assert.ok(Number(observation.args[2]) >= before && Number(observation.args[2]) <= after);
  result = invoke(['list', '--json']); assert.equal(result.status, 0, result.stderr);
  observation = JSON.parse(fs.readFileSync(record)); assert.deepEqual(observation.args, ['groups', '--json']);
  result = invoke(['list', '--json'], { GROUP_NAME_FIXTURE_FAIL: '1' });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).error.code, 'C4_GROUPS_FAILED'); assert.equal('data' in JSON.parse(result.stdout), false);
});
