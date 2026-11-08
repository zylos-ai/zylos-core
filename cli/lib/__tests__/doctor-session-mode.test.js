import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDiagnostics, buildDiagnosticJson, readDoctorSessionModeStatus,
  formatDoctorSessionModeStatus, isDiagnosticOnlyIssue } from '../../commands/doctor.js';
import { readSessionModeStatus } from '../session-mode-status.js';

const row = { run_id: 'legacy-switch', source_mode: 'single', target_mode: 'multi',
  phase: 'gating', cutoff: null, reason: 'running_control_without_deadline:machine:4698',
  created_at: 100, updated_at: 102 };
const statusOptions = (transition = row) => ({
  db: { getModeTransition: () => transition, getDrainFence: () => ({ reason: null, runId: null }),
    getLastCompletedModeTransition: () => null },
  readMode: () => ({ mode: 'single' }), readEvents: () => [], probeSupervisor: () => true,
});
const healthy = sessionModeStatus => ({
  runtime: 'claude', display: 'Claude', apiHost: 'fixture.invalid', sessionModeStatus,
  system: { tmux: { installed: true }, pm2: { installed: true }, network: { reachable: true } },
  ai: { cli: { installed: true }, auth: true, authStatus: 'success', autonomous: true },
  services: { running: true, total: 1, procs: [{ name: 'activity-monitor', pm2_env: { status: 'online' } }], session: false },
});
const version = { success: true, version: '1.0.0' };

test('doctor keeps session mode diagnostics out of automatic fixes', async () => {
  const blocked = await readDoctorSessionModeStatus({ databaseExists: () => true,
    readStatus: () => readSessionModeStatus(statusOptions()) });
  const unavailable = await readDoctorSessionModeStatus({ databaseExists: () => true,
    readStatus: () => { throw new Error('database held'); } });
  for (const value of [blocked, unavailable]) {
    const diag = healthy(value);
    diag.system.tmux.installed = false;
    const issues = buildDiagnosticJson(diag, version).issues;
    const modeIssue = issues.find(issue => issue.id.startsWith('session_mode_'));
    assert.ok(modeIssue);
    assert.equal(isDiagnosticOnlyIssue(modeIssue), true);
    const fixable = issues.filter(issue => !isDiagnosticOnlyIssue(issue));
    assert.ok(fixable.length > 0, 'ordinary installation issues remain fixable');
    assert.equal(fixable.some(issue => issue.id.startsWith('session_mode_')), false);
  }
  assert.equal(isDiagnosticOnlyIssue({ id: 'origin_unavailable' }), true);
});

test('doctor collector retains authoritative gating phase and blocker', async () => {
  let reads = 0;
  const modeStatus = () => readDoctorSessionModeStatus({ databaseExists: () => true,
    readStatus: () => { reads++; return readSessionModeStatus(statusOptions()); } });
  const diag = await collectDiagnostics({}, {
    resolve: () => ({ runtime: 'unknown', sessionGroup: null, live: { tmuxName: 'unused' } }),
    tmuxCheck: () => ({ installed: false }), pm2Check: () => ({ installed: false }),
    network: () => assert.fail('unknown runtime must not probe network'), modeStatus,
  });
  assert.equal(reads, 1);
  assert.equal(diag.sessionModeStatus.status.transition.phase, 'gating');
  assert.equal(diag.sessionModeStatus.status.blocked.reason, row.reason);
  const json = buildDiagnosticJson(healthy(diag.sessionModeStatus), version);
  assert.equal(json.passed, false);
  assert.equal(json.groups.services.passed, false);
  assert.deepEqual(json.groups.services.sessionModeStatus, diag.sessionModeStatus);
  assert.equal(json.issues.length, 1);
  assert.equal(json.issues[0].id, 'session_mode_transition_blocked');
  assert.match(json.issues[0].label, /single -> multi \(gating\) blocked: running_control_without_deadline:machine:4698/);
  const text = formatDoctorSessionModeStatus(diag.sessionModeStatus).join('\n');
  assert.match(text, /Mode transition: single -> multi \(gating\)/);
  assert.match(text, /Global gate: present/);
  assert.match(text, /Mode transition blocked: running_control_without_deadline:machine:4698/);
});

for (const transition of [null, { ...row, reason: null }]) {
  test(`doctor ${transition ? 'unblocked gating' : 'no open transition'} stays informational`, async () => {
    const value = await readDoctorSessionModeStatus({ databaseExists: () => true,
      readStatus: () => readSessionModeStatus(statusOptions(transition)) });
    const json = buildDiagnosticJson(healthy(value), version);
    assert.equal(json.passed, true);
    assert.deepEqual(json.issues, []);
    const text = formatDoctorSessionModeStatus(value).join('\n');
    assert.match(text, transition ? /\(gating\)/ : /Mode transition: none/);
    assert.doesNotMatch(text, /blocked:/);
  });
}

test('doctor failed authoritative reads are explicit and fail services', async () => {
  const options = statusOptions();
  options.db.getModeTransition = () => { throw Object.assign(new Error('database held'), { code: 'DB_BUSY' }); };
  const value = await readDoctorSessionModeStatus({ databaseExists: () => true,
    readStatus: () => readSessionModeStatus(options) });
  assert.equal(value.status, null);
  assert.deepEqual(value.error, { code: 'DB_BUSY', message: 'database held' });
  assert.equal(value.skipped, false);
  const json = buildDiagnosticJson(healthy(value), version);
  assert.equal(json.passed, false);
  assert.equal(json.groups.services.passed, false);
  assert.equal(json.issues[0].id, 'session_mode_status_unavailable');
  assert.deepEqual(formatDoctorSessionModeStatus(value), ['Session mode status unavailable: DB_BUSY: database held']);
});

test('doctor missing uninitialized database is visible without creating or reading it', async () => {
  const value = await readDoctorSessionModeStatus({ databaseExists: () => false,
    readStatus: () => assert.fail('a missing database must not be opened') });
  assert.equal(value.status, null);
  assert.equal(value.error.code, 'DB_NOT_FOUND');
  assert.equal(value.skipped, true);
  assert.match(formatDoctorSessionModeStatus(value)[0], /not initialized/);
  const json = buildDiagnosticJson(healthy(value), version);
  assert.equal(json.passed, true);
  assert.deepEqual(json.issues, []);
});

test('doctor denied database inspection is a read failure rather than an uninitialized database', async () => {
  const value = await readDoctorSessionModeStatus({
    databaseExists: () => { throw Object.assign(new Error('inspection denied'), { code: 'EACCES' }); },
    readStatus: () => assert.fail('inspection failure must stop the read'),
  });
  assert.equal(value.skipped, false);
  assert.equal(value.error.code, 'EACCES');
  assert.equal(buildDiagnosticJson(healthy(value), version).passed, false);
  assert.match(formatDoctorSessionModeStatus(value)[0], /EACCES: inspection denied/);
});
