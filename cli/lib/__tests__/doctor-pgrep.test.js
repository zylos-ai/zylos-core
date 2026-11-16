import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkPgrep, collectDiagnostics, buildDiagnosticJson, pgrepHint } from '../../commands/doctor.js';

const version = { success: true, version: '1.0.0' };
const healthy = pgrep => ({
  runtime: 'claude', display: 'Claude', apiHost: 'fixture.invalid', sessionModeStatus: null,
  system: { tmux: { installed: true }, pm2: { installed: true }, pgrep, network: { reachable: true } },
  ai: { cli: { installed: true }, auth: true, authStatus: 'success', autonomous: true },
  services: { running: true, total: 1, procs: [{ name: 'activity-monitor', pm2_env: { status: 'online' } }], session: false },
});

test('doctor probe reports pgrep missing from PATH as not_found', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-no-pgrep-')), saved = process.env.PATH;
  process.env.PATH = dir;
  t.after(() => { process.env.PATH = saved; fs.rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(checkPgrep(), { available: false, reason: 'not_found' });
});

// Without pgrep, a PATH directory the user cannot search turns ENOENT into
// EACCES. Root bypasses the permission, so the case cannot be built as root.
test('doctor probe reports EACCES when a PATH directory denies access', { skip: process.getuid?.() === 0 && 'root bypasses directory permissions' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-locked-path-')), locked = path.join(dir, 'locked'), saved = process.env.PATH;
  fs.mkdirSync(locked, { mode: 0o000 });
  process.env.PATH = `${locked}${path.delimiter}${dir}`;
  t.after(() => { process.env.PATH = saved; fs.chmodSync(locked, 0o700); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(checkPgrep(), { available: false, reason: 'EACCES' });
});

const hasPgrep = spawnSync('pgrep', ['-f', '[n]o-such-process-pattern']).status === 1;
test('doctor probe accepts an installed pgrep', { skip: !hasPgrep && 'pgrep is not installed' }, () => {
  assert.deepEqual(checkPgrep(), { available: true });
});

test('doctor probe treats match and no-match as available and other failures as unusable', () => {
  assert.deepEqual(checkPgrep({ execute: () => '' }), { available: true });
  assert.deepEqual(checkPgrep({ execute: () => { throw Object.assign(Error(), { status: 1 }); } }), { available: true });
  assert.deepEqual(checkPgrep({ execute: () => { throw Object.assign(Error(), { code: 'ETIMEDOUT' }); } }), { available: false, reason: 'ETIMEDOUT' });
  assert.deepEqual(checkPgrep({ execute: () => { throw Object.assign(Error(), { status: 3 }); } }), { available: false, reason: 'exit_3' });
});

test('missing pgrep is a doctor warning that does not fail the system group or the run', async () => {
  const diag = await collectDiagnostics({}, {
    resolve: () => ({ runtime: 'unknown', sessionGroup: null, live: { tmuxName: 'unused' } }),
    tmuxCheck: () => ({ installed: false }), pm2Check: () => ({ installed: false }),
    pgrepCheck: () => ({ available: false, reason: 'not_found' }),
    network: () => assert.fail('unknown runtime must not probe network'),
    modeStatus: async () => ({ status: null, error: null, skipped: true }),
  });
  assert.deepEqual(diag.system.pgrep, { available: false, reason: 'not_found' });
  const json = buildDiagnosticJson(healthy(diag.system.pgrep), version);
  assert.equal(json.passed, true);
  assert.equal(json.groups.system.passed, true);
  assert.deepEqual(json.groups.system.checks.pgrep, { ok: false, level: 'warning', reason: 'not_found',
    hint: 'Maintenance check before single-session startup will be skipped; install procps' });
  assert.equal(json.issues.some(issue => /pgrep/.test(issue.id + issue.label)), false);
});

test('doctor hint follows the pgrep failure: skipped for not_found and EACCES, startup failure otherwise', () => {
  for (const reason of ['not_found', 'EACCES', 'ETIMEDOUT']) {
    const json = buildDiagnosticJson(healthy({ available: false, reason }), version);
    assert.equal(json.passed, true);
    assert.deepEqual(json.groups.system.checks.pgrep, { ok: false, level: 'warning', reason, hint: pgrepHint(reason) });
  }
  assert.equal(pgrepHint('EACCES'), 'Maintenance check before single-session startup will be skipped; install procps and make every PATH directory accessible');
  assert.equal(pgrepHint('ETIMEDOUT'), 'Single-session startup fails while pgrep cannot be run; check that procps works');
});

test('available pgrep passes the doctor check', () => {
  const json = buildDiagnosticJson(healthy({ available: true }), version);
  assert.deepEqual(json.groups.system.checks.pgrep, { ok: true });
  assert.equal(json.passed, true);
});
