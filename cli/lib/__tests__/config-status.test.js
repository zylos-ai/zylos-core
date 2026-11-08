import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectStatus } from '../status-view.js';
import { showStatus, collectHostStatus } from '../../commands/service.js';
import { readConfigStrict } from '../config-store.js';
import { readInstanceConfigurationIssue } from '../instance-config-status.js';

const badConfigs = [
  ['invalid JSON', '{', /JSON/],
  ['unsupported runtime', '{"runtime":"unsupported","session_mode":"multi"}', /Unsupported runtime: unsupported/],
  ['invalid session mode', '{"session_mode":"wrong"}', /Invalid baseline session mode/],
];
const valid = '{"runtime":"claude","session_mode":"single"}';
// Availability is a live statfs sample; preserve the total and every other line.
const stableStatusText = text => text.replace(/^(Disk: )\d+( GiB available \/ \d+ GiB total)$/m, '$1<sample>$2');

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
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
      assert.ok(env[key].startsWith(root + path.sep) || env[key] === root);
    }
    console.log(JSON.stringify({ root, ...env, configPath: filename, tmux: 'not spawned' }));
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
    assert.match(issue.notice, /automatic if the communication service was already running/);
    assert.match(issue.notice, /started or restarted.*zylos restart/);
    const text = run([]);
    assert.equal(text.split('\n')[0], issue.notice);
    assert.match(text, /fixture-scheduler: online/);
    assert.match(text, /Disk: \d+ GiB available \/ \d+ GiB total/);
    assert.match(text, /Alert target:/);
    assert.equal(fs.readFileSync(filename, 'utf8'), source, 'diagnostics never fix config');
    fs.writeFileSync(filename, valid);
    const repairedText = run([]);
    assert.match(repairedText, /Disk: \d+ GiB available \/ \d+ GiB total/);
    assert.equal(stableStatusText(repairedText), stableStatusText(baseline),
      'healthy output is unchanged after repair apart from live disk availability');
    assert.equal(fs.readFileSync(filename, 'utf8'), valid, 'healthy diagnostics never modify repaired config');
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

test('a healthy configuration keeps an unrelated collector failure silent on stdout', async () => {
  const lines = [], errors = [], log = console.log, err = console.error, exitCode = process.exitCode;
  console.log = line => lines.push(line); console.error = line => errors.push(line);
  try {
    const deps = { collect: () => { throw new Error('session reader unavailable'); },
      configIssue: () => readInstanceConfigurationIssue({ read: () => ({ state: 'ok', config: {} }) }),
      host: () => assert.fail('Healthy collector failure must not query host extras'),
      alertNotice: () => assert.fail('Healthy collector failure must not print alert target') };
    const result = await showStatus([], deps);
    assert.equal(result.ok, false);
    assert.equal(lines.length, 0);
    assert.match(errors[0], /STATUS_UNAVAILABLE/);
    await showStatus(['--json'], deps);
    const json = JSON.parse(lines[0]);
    assert.equal(json.error.code, 'STATUS_UNAVAILABLE');
    assert.equal('configurationIssue' in json, false);
    assert.equal('data' in json, false);
  } finally { console.log = log; console.error = err; process.exitCode = exitCode; }
});

// Boundary: real status rendering with controlled host disk samples. No live IO.
// Run for status output/config diagnostics; unrelated runtime delivery may skip.
test('healthy status changes only its sampled disk availability when host space changes', async () => {
  const log = console.log, lines = [];
  console.log = line => lines.push(line);
  try {
    const render = async available => {
      lines.length = 0;
      await showStatus([], { collect: () => collectStatus(fixture()),
        host: () => collectHostStatus({ exec: () => '[]',
          disk: () => ({ blocks: 512, bavail: available, bsize: 1024 ** 3 }) }),
        alertNotice: () => ({ kind: 'ready' }) });
      return lines.join('\n');
    };
    const before = await render(128), after = await render(129);
    assert.notEqual(before, after, 'real host samples change rendered bytes');
    assert.match(before, /^Disk: 128 GiB available \/ 512 GiB total$/m);
    assert.match(after, /^Disk: 129 GiB available \/ 512 GiB total$/m);
    assert.equal(stableStatusText(before), stableStatusText(after));
    assert.notEqual(stableStatusText(after.replace('512 GiB total', '513 GiB total')), stableStatusText(before));
  } finally { console.log = log; }
});
