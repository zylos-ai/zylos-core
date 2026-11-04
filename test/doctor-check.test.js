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

function runDoctor(args, { state = 'fail', network = 'up', mode = 'single', origin = 'sleeping', group = 'origin', runtime = 'claude' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doc-')));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  const dirs = { HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'zylos'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp') };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const command of ['which', 'claude', 'codex', 'pm2', 'tmux', 'curl']) {
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
  fs.writeFileSync(path.join(dirs.ZYLOS_DIR, '.zylos', 'config.json'), JSON.stringify({ runtime, session_mode: mode }));
  const env = { ...dirs, PATH: bin, CLAUDE_BIN: path.join(bin, 'claude'),
    DOCTOR_TEST_ROOT: root, DOCTOR_TEST_STATE: state, DOCTOR_TEST_NETWORK: network,
    DOCTOR_TEST_MODE: mode, DOCTOR_TEST_ORIGIN: origin, ZYLOS_SESSION_GROUP: group, DOCTOR_TEST_RUNTIME: runtime,
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
  const databaseCreated = fs.existsSync(path.join(dirs.ZYLOS_DIR, 'comm-bridge', 'c4.db'));
  return { ...result, calls, probes, repairs, versions, databaseCreated };
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

for (const [origin, pattern] of [
  ['sleeping', /Origin is asleep; it wakes automatically when there is work\./],
  ['waking', /Origin is waking up\./],
  ['rate_wait', /Origin is waiting for the claude rate limit to clear/],
]) {
  // Boundary: absent Origin with healthy services is a normal demand-driven state.
  // Run for absent-session display or repair gates; skip changes outside doctor.
  test(`absent Origin ${origin} passes services without starting repair`, () => {
    const result = runDoctor(['--check'], { mode: 'multi', state: 'pass', origin });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, pattern);
    assert.doesNotMatch(result.stdout, /Claude session is starting|session: starting/);
    assert.equal(result.repairs.length, 0);
  });
}

// Boundary: wake failure remains a human diagnostic even when Claude can repair.
// Run for the Origin issue/repair boundary; skip unrelated doctor changes.
test('overdue Origin exits with a diagnostic hint and never starts repair', () => {
  const result = runDoctor([], { mode: 'multi', state: 'pass', origin: 'wake_overdue' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Origin has pending work but has not started for over 5 minutes/);
  assert.match(result.stdout, /router-events\.jsonl/);
  assert.equal(result.repairs.length, 0);
  assert.doesNotMatch(result.stdout, /Re-checking/);
});

// Boundary: an independent service fault still repairs, excluding wake diagnostics.
// Run alongside repair gate tests; skip when repair issue selection is unaffected.
test('service repair receives no Origin wake issue and recheck retains the failure', () => {
  const result = runDoctor([], { mode: 'multi', origin: 'wake_overdue' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.repairs.length, 1);
  assert.match(result.repairs[0].args[1], /worker-a offline/);
  assert.doesNotMatch(result.repairs[0].args[1], /Origin has pending work|origin_wake_overdue/);
  assert.match(result.stdout, /3 issue\(s\) remain:/);
  assert.match(result.stdout, /router-events\.jsonl/);
});

// Boundary: JSON reports wake failure without changing observed session presence.
// Run for doctor JSON/Origin state changes; skip unrelated doctor logic.
test('doctor JSON includes the overdue Origin issue and services state', () => {
  const result = runDoctor(['--json'], { mode: 'multi', state: 'pass', origin: 'wake_overdue' });
  assert.equal(result.status, 1, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.groups.services.passed, false);
  assert.deepEqual(json.groups.services.session, { active: false, origin: 'wake_overdue' });
  assert.deepEqual(json.issues.map(issue => issue.id), ['origin_wake_overdue']);
});

// Boundary: auth display uses the configured absent target runtime, not a scene.
// Run for auth issue text or target-runtime changes; skip unrelated doctor logic.
test('absent Codex Origin authentication issue gives the Codex login hint', () => {
  const result = runDoctor(['--json'], { mode: 'multi', state: 'pass', origin: 'auth_wait', runtime: 'codex' });
  assert.equal(result.status, 1, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.groups.services.session.origin, 'auth_wait');
  assert.deepEqual(json.issues, [{ id: 'origin_auth_wait', label: 'Origin is waiting for Codex authentication', hint: 'Run: codex login' }]);
  assert.equal(result.repairs.length, 0);
});

// Boundary: ordinary absent groups use neutral wording and do not read Origin need.
// Run for multi-session doctor display changes; skip unrelated doctor logic.
test('absent ordinary group uses next-message wording', () => {
  const result = runDoctor(['--check'], { mode: 'multi', state: 'pass', group: 'telegram_test' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /session: not running \(starts on the next message for this group\)/);
  assert.doesNotMatch(result.stdout, /Origin is asleep|Claude session is starting|session: starting/);
});

// Boundary: a failed C4 read is an unavailable wake diagnostic, never sleep.
// Run for Origin read/issue/repair changes; skip unrelated doctor logic.
test('unreadable Origin wake data fails services without repair', () => {
  const result = runDoctor(['--json'], { mode: 'multi', state: 'pass', origin: 'need_unreadable' });
  assert.equal(result.status, 1, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.groups.services.passed, false);
  assert.equal(json.groups.services.session.origin, 'need_unreadable');
  assert.deepEqual(json.issues, [{ id: 'origin_status_unavailable', label: 'Origin wake status unavailable', hint: 'Run: zylos status --json' }]);
  assert.equal(result.repairs.length, 0);
});

// Boundary: a missing C4 file must remain missing while doctor reports failure.
// Run for target-resolution or read-only C4 changes; skip unrelated doctor logic.
test('missing C4 database reports unavailable wake data without creating a file', () => {
  const result = runDoctor(['--json'], { mode: 'multi', state: 'pass', origin: 'missing_db' });
  assert.equal(result.status, 1, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.groups.services.session.origin, 'need_unreadable');
  assert.equal(json.groups.services.passed, false);
  assert.ok(json.issues.some(issue => issue.id === 'origin_status_unavailable'));
  assert.ok(json.issues.some(issue => issue.id === 'runtime_unknown'));
  assert.equal(result.databaseCreated, false);
  assert.equal(result.repairs.length, 0);
});
