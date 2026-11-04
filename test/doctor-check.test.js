import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test, afterEach } from '@jest/globals';

const child = fileURLToPath(new URL('./helpers/doctor-check-child.js', import.meta.url));
const fakeCommand = fileURLToPath(new URL('./helpers/doctor-check-command.js', import.meta.url));
const hints = ['Check: pm2 logs worker-a', 'Check: pm2 logs worker-b'];
const cleanup = [];
afterEach(() => { for (const clean of cleanup.splice(0)) clean(); });

function runDoctor(args, { state = 'fail', network = 'up', alertTarget, sender = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doc-')));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  const dirs = { HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'zylos'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp') };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const command of ['which', 'claude', 'pm2', 'tmux', 'curl']) {
    const destination = path.join(bin, command);
    // Absolute Node interpreter keeps PATH restricted to the fixture commands.
    fs.writeFileSync(destination, fs.readFileSync(fakeCommand, 'utf8')
      .replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o700 });
  }
  fs.mkdirSync(path.join(dirs.HOME, '.claude'));
  fs.writeFileSync(path.join(dirs.HOME, '.claude', 'settings.json'),
    JSON.stringify({ skipDangerousModePermissionPrompt: true }));
  fs.mkdirSync(path.join(dirs.ZYLOS_DIR, '.zylos'));
  fs.mkdirSync(path.join(dirs.ZYLOS_DIR, '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dirs.ZYLOS_DIR, '.zylos', 'components.json'), '{}');
  fs.writeFileSync(path.join(dirs.ZYLOS_DIR, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude', ...(alertTarget === undefined ? {} : { alert_target: alertTarget }) }));
  if (sender) {
    const directory = path.join(dirs.ZYLOS_DIR, '.claude', 'skills', 'telegram', 'scripts');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'send.js'), '');
  }
  const env = { ...dirs, PATH: bin, CLAUDE_BIN: path.join(bin, 'claude'),
    DOCTOR_TEST_ROOT: root, DOCTOR_TEST_STATE: state, DOCTOR_TEST_NETWORK: network,
    DOCTOR_TEST_TMUX_SOCKET: path.join(dirs.TMPDIR, 'tmux.sock'), NO_COLOR: '1',
    ZYLOS_GH_RETRY_DELAY_MS: '' };
  for (const [key, dir] of Object.entries(dirs)) assert.equal(fs.realpathSync(env[key]), dir);
  assert.ok(Buffer.byteLength(env.DOCTOR_TEST_TMUX_SOCKET) < 100, 'Use a short temporary parent');
  const result = spawnSync(process.execPath, [child, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.match(result.stderr, /doctor isolation:/, result.stderr);
  console.log(result.stderr.trim());
  const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const claude = calls.filter(call => call.command === 'claude');
  const probes = claude.filter(call => call.args[0] === '-p' && call.args[1] === 'ping');
  const repairs = claude.filter(call => call.args[0] === '-p' && call.args[1] !== 'ping');
  const versions = claude.filter(call => call.args[0] === '--version');
  assert.equal(claude.length, probes.length + repairs.length + versions.length);
  assert.ok(calls.filter(call => call.command === 'tmux').every(call =>
    call.socket === env.DOCTOR_TEST_TMUX_SOCKET));
  return { ...result, calls, probes, repairs, versions };
}

// Boundary: alert destination is informational in real doctor text/JSON flow.
// Run for alert notice changes; skip for unrelated doctor repair behavior. Uses
// private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR and fake tmux on a private socket;
// no C4 database or live services; runDoctor verifies paths and removes fixtures.
for (const [alertTarget, sender, message] of [
  [undefined, false, /Alert target: 未设置：系统告警只发到 Web Console/],
  ['web-console:console', false, /Alert target: 主人选了只发 Web Console/],
  ['invalid', false, /Alert target: 值不合法/],
  ['telegram:room', false, /Alert target: 渠道 telegram 的 scripts\/send.js 不存在/],
  ['telegram:room', true, /Alert target: telegram:room/],
]) {
  test(`alert destination ${alertTarget ?? 'missing'} sender=${sender} is a notice without diagnostic failure`, () => {
    const text = runDoctor(['--check'], { state: 'pass', alertTarget, sender });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, message);
    assert.match(text.stdout, /Everything is working/);
    const json = runDoctor(['--check', '--json'], { state: 'pass', alertTarget, sender });
    assert.equal(json.status, 0, json.stderr);
    const result = JSON.parse(json.stdout);
    assert.equal(result.passed, true);
    assert.equal(result.groups.services.passed, true);
    assert.deepEqual(result.issues, []);
    assert.equal('alertTarget' in result, false);
  });
}

// Boundary: ready Claude plus two unresolved services. Run for check gating/hint/exit
// changes; skip when a change cannot affect doctor command flow or these outputs.
test('check mode keeps issue hints and skips repair and rechecking', () => {
  const result = runDoctor(['--check']);
  assert.equal(result.status, 1, result.stderr);
  for (const name of ['worker-a', 'worker-b']) assert.match(result.stdout, new RegExp(`${name} offline`));
  for (const hint of hints) assert.ok(result.stdout.includes(hint), result.stdout);
  assert.match(result.stdout, /Run zylos init to set up your environment\./);
  assert.doesNotMatch(result.stdout, /Claude is fixing|Re-checking/);
  assert.equal(result.repairs.length, 0);
  assert.equal(result.probes.length, 1);
  assert.equal(result.versions.length, 1);
  assert.equal(result.calls.filter(call => call.command === 'pm2' && call.args[0] === 'jlist').length, 1);
});

// Boundary: the identical unresolved fixture without check must repair and recheck.
// Run alongside gate tests; skip only when doctor repair dispatch is unaffected.
test('default mode still invokes repair and rechecks unresolved issues', () => {
  const result = runDoctor([]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.repairs.length, 1);
  assert.match(result.repairs[0].args[1], /^You are a Zylos repair agent\./);
  assert.equal(result.probes.length, 2);
  assert.equal(result.versions.length, 2);
  assert.match(result.stdout, /Claude is fixing issues/);
  assert.match(result.stdout, /Re-checking/);
  assert.match(result.stdout, /2 issue\(s\) remain:/);
  for (const hint of hints) assert.ok(result.stdout.includes(hint));
});

// Boundary: an all-pass diagnostic exits successfully without repair. Run for
// doctor check gating/exit changes; skip changes outside doctor command flow.
test('check mode exits successfully when all diagnostics pass', () => {
  const result = runDoctor(['--check'], { state: 'pass' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Everything is working\./);
  assert.equal(result.repairs.length, 0);
  assert.equal(result.probes.length, 1);
  assert.equal(result.versions.length, 1);
});

for (const args of [['--json'], ['--check', '--json']]) {
  for (const state of ['fail', 'pass']) {
    // Boundary: both JSON forms retain their pre-existing early exit and report.
    // Run for doctor flag/JSON/repair-flow changes; skip unrelated product changes.
    test(`${args.join(' ')} preserves ${state} JSON diagnostics without repair`, () => {
      const result = runDoctor(args, { state });
      assert.equal(result.status, state === 'pass' ? 0 : 1, result.stderr);
      const json = JSON.parse(result.stdout);
      assert.equal(json.passed, state === 'pass');
      assert.deepEqual(json.issues.map(issue => issue.hint), state === 'pass' ? [] : hints);
      assert.equal(result.repairs.length, 0);
      assert.equal(result.probes.length, 1);
      assert.equal(result.versions.length, 1);
    });
  }
}

// Boundary: unavailable network keeps the existing manual network guidance.
// Run for doctor check/hint/bottom-message changes; skip unrelated product changes.
test('check mode keeps network failure guidance without repair', () => {
  const result = runDoctor(['--check'], { state: 'pass', network: 'down' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Cannot reach api\.anthropic\.com/);
  assert.match(result.stdout, /Check internet connection and firewall settings\./);
  assert.match(result.stdout, /Check your network connection and run zylos doctor again\./);
  assert.equal(result.repairs.length, 0);
  assert.equal(result.probes.length, 1);
  assert.equal(result.versions.length, 1);
});
