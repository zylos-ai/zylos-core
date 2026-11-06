import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectStatus } from '../status-view.js';
import { showStatus } from '../../commands/service.js';
import { readConfigStrict } from '../config-store.js';
import { readInstanceConfigurationIssue } from '../instance-config-status.js';

const badConfigs = [
  ['invalid JSON', '{', /JSON/],
  ['unsupported runtime', '{"runtime":"unsupported","session_mode":"multi"}', /Unsupported runtime: unsupported/],
  ['invalid session mode', '{"session_mode":"wrong"}', /session_mode must be/],
];
const valid = '{"runtime":"claude","session_mode":"single"}';

// Real CLI, filesystem configuration and process entry. Run for status/config
// diagnostics; skip unrelated runtime delivery changes. The official runner
// isolates HOME/ZYLOS_DIR/PM2_HOME and short TMPDIR; each child gets a private
// environment and PATH containing only the fixture PM2 reader (no tmux/runtime).
// spawnSync bounds every child; no daemon/socket/network/online database is used.
for (const [name, source, reason] of badConfigs) {
  test(`status explains ${name} and clears the notice after repair`, { timeout: 15000 }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-config-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const zylos = path.join(root, 'home', 'zylos');
    const filename = path.join(zylos, '.zylos', 'config.json');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pm2'), `#!${process.execPath}\nconsole.log('[{"name":"fixture-scheduler","pm2_env":{"status":"online"}}]');\n`, { mode: 0o755 });
    const env = { HOME: path.join(root, 'home'), ZYLOS_DIR: zylos, PM2_HOME: path.join(root, 'pm2'),
      TMPDIR: root, TMUX_TMPDIR: root, PATH: bin, NO_COLOR: '1', ZYLOS_PACKAGE_ROOT: new URL('../../../', import.meta.url).pathname };
    const run = args => {
      const result = spawnSync(process.execPath, [new URL('../../zylos.js', import.meta.url).pathname, 'status', ...args],
        { env, encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    fs.writeFileSync(filename, valid);
    const baseline = run([]);
    const baselineJson = JSON.parse(run(['--json']));
    assert.equal(baselineJson.ok, true);
    assert.equal('configurationIssue' in baselineJson.data, false);
    fs.writeFileSync(filename, source);
    const json = JSON.parse(run(['--json']));
    assert.equal(json.ok, true, 'partial session status remains available');
    const issue = json.data.configurationIssue;
    assert.equal(issue.code, 'CONFIG_UNREADABLE');
    assert.match(issue.message, reason);
    assert.match(issue.notice, /All groups \(including Origin\) cannot start/);
    assert.match(issue.notice, /automatically after the configuration is fixed/);
    const text = run([]);
    assert.equal(text.split('\n')[0], issue.notice);
    assert.match(text, /fixture-scheduler: online/);
    assert.match(text, /Disk: \d+ GiB available \/ \d+ GiB total/);
    assert.match(text, /Alert target:/);
    assert.equal(fs.readFileSync(filename, 'utf8'), source, 'diagnostics never fix config');
    fs.writeFileSync(filename, valid);
    assert.equal(run([]), baseline, 'healthy output is byte-identical after repair');
    const repaired = JSON.parse(run(['--json']));
    assert.equal('configurationIssue' in repaired.data, false);
    assert.deepEqual(Object.keys(repaired.data), Object.keys(baselineJson.data));
  });
}

const fixture = () => ({ mode: () => ({ mode: 'single' }), configIssue: () => null,
  resolveRoot: () => {}, now: () => 1234, runtimes: [],
  session: async () => ({ identity: { present: false }, status: { valid: false, reason: 'not_running', sampledAt: null } }) });

test('healthy status projection retains the baseline shape', async () => {
  assert.deepEqual(await collectStatus(fixture()), {
    sessionMode: 'single', view: 'single', origin: { sessionGroup: null, presence: 'not_running', runId: null,
      sessionId: null, runtime: null, status: { valid: false, reason: 'not_running', state: null, idleSeconds: null, sampledAt: null }, error: null },
    originNeed: null, groups: [], groupListError: null, runtimeHealth: {}, readAt: 1234,
  });
});

test('configuration notice survives an unrelated status collector failure', async () => {
  const issue = readInstanceConfigurationIssue({ read: () => ({ state: 'error', error: Object.assign(new Error('permission denied'), { code: 'EACCES' }) }) });
  const lines = [], errors = [], log = console.log, err = console.error, exitCode = process.exitCode;
  console.log = line => lines.push(line); console.error = line => errors.push(line);
  try {
    const deps = { collect: () => { throw new Error('session reader unavailable'); }, configIssue: () => issue,
      host: () => ({ services: [{ name: 'fixture', status: 'online' }], disk: null }),
      alertNotice: () => ({ kind: 'warning', text: 'instance config unreadable' }) };
    const result = await showStatus([], deps);
    assert.equal(result.ok, false);
    assert.equal(lines[0], issue.notice);
    assert.match(lines.join('\n'), /fixture: online/);
    assert.match(lines.join('\n'), /Disk: unavailable/);
    assert.match(lines.join('\n'), /Alert target: instance config unreadable/);
    assert.match(errors[0], /STATUS_UNAVAILABLE/);
    lines.length = 0;
    await showStatus(['--json'], deps);
    assert.deepEqual(JSON.parse(lines[0]).configurationIssue, issue);
  } finally { console.log = log; console.error = err; process.exitCode = exitCode; }
});

test('strict read failures and optional baseline defaults use the same diagnostic', () => {
  for (const result of [{ state: 'missing' }, { state: 'ok', config: {} }, { state: 'ok', config: {runtime:null} }]) {
    assert.equal(readInstanceConfigurationIssue({ read: () => result }), null);
  }
  const issue = readInstanceConfigurationIssue({ read: () => { throw new Error('read denied'); } });
  assert.equal(issue.code, 'CONFIG_UNREADABLE');
  assert.equal(issue.message, 'read denied');
  for (const source of ['[]', 'null', '42']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-root-'));
    try {
      const file = path.join(root, 'config.json'); fs.writeFileSync(file, source);
      assert.match(readInstanceConfigurationIssue({ read: () => readConfigStrict(file) }).message, /JSON object/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
