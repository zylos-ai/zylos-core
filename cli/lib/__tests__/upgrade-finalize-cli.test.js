import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseUpgradeFinalizeOptions, formatFinalizeResult, formatSelfUpgradeCompletion, formatC4Reply } from '../../commands/component.js';

const modulePath = fileURLToPath(new URL('../../commands/component.js', import.meta.url));

test('text and JSON reply report independent outcomes without promising restart readiness', () => {
  const result = { success: true, from: '0.9.0', to: '0.9.2', settingsChanged: true,
    completion: { install: 'done', dashboard: 'degraded', sessionRestart: 'manual_required', modeTransition: 'unknown' },
    dashboard: { errors: [{ item: 'route', code: 'ROUTE_FAILED', message: 'reload failed' }] },
    sessionRestart: { ok: false, error: { code: 'TIMEOUT', message: 'submission timed out' } },
    modeStatus: { state: 'unavailable', error: { message: 'P10 unavailable' } },
    next: 'Resolve the failure before restarting.' };
  const text = formatSelfUpgradeCompletion(result);
  const json = JSON.parse(JSON.stringify({ ...result, reply: formatC4Reply('self-upgrade', result) }));
  for (const expected of ['Installation: done', 'Dashboard: degraded', 'Session restart: manual_required',
    'Mode transition: unknown', 'ROUTE_FAILED: reload failed', 'TIMEOUT: submission timed out',
    'Mode status: unavailable: P10 unavailable', 'Manual runtime restart required', result.next]) {
    assert.ok(text.includes(expected), expected);
    assert.ok(json.reply.includes(expected), expected);
  }
  assert.deepEqual(json.completion, result.completion);
  assert.equal(Object.hasOwn(json, 'instructionFilesRebuilt'), false);
  assert.doesNotMatch(json.reply, /No action needed|restart automatically|ready/i);
});

test('accepted restart and legacy settings results never invent readiness or automatic submission', () => {
  const accepted = { success: true, completion: { install: 'done', dashboard: 'ready', sessionRestart: 'accepted', modeTransition: 'in_progress' },
    sessionRestart: { ok: true, data: { result: 'accepted' } }, settingsChanged: true };
  const reply = formatC4Reply('self-upgrade', accepted);
  assert.match(reply, /Session restart: accepted/);
  assert.doesNotMatch(reply, /Manual runtime restart|No action needed|restart automatically/);
  const legacy = formatC4Reply('self-upgrade', { success: true, settingsChanged: true });
  assert.match(legacy, /Restart the runtime to load/);
  assert.doesNotMatch(legacy, /No action needed|restart automatically/);
});

test('failed upgrade replies retain completion and forward repair guidance', () => {
  const reply = formatC4Reply('self-upgrade', { success: false, error: 'service start failed',
    completion: { install: 'pending', dashboard: 'degraded', sessionRestart: 'manual_required', modeTransition: 'unknown' },
    next: 'Run zylos upgrade --resume-finalize.' });
  assert.match(reply, /upgrade failed: service start failed/);
  assert.match(reply, /Installation: pending/);
  assert.match(reply, /--resume-finalize/);
});

test('unknown restart result retains request identity and forbids automatic resubmission', () => {
  const reply = formatC4Reply('self-upgrade', { success: true,
    completion: { sessionRestart: 'manual_required' },
    sessionRestart: { ok: false, requestId: 'restart-uncertain', error: { code: 'restart_result_unknown', message: 'No reply' } } });
  assert.match(reply, /Restart request: restart-uncertain/);
  assert.match(reply, /result is unknown/);
  assert.match(reply, /Do not resubmit automatically/);
  assert.doesNotMatch(reply, /Manual runtime restart required/);
});

test('actual target CLI displays completion in text and JSON without submitting another restart', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-cli-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = { success: true, from: '0.9.0', to: '0.9.2', settingsChanged: true,
    completion: { install: 'done', dashboard: 'degraded', sessionRestart: 'manual_required', modeTransition: 'unknown' },
    sessionRestart: { ok: false, error: { code: 'SUBMISSION_FAILED', message: 'entry unavailable' } },
    publication: { warnings: [{ targetId: 't04', code: 'CONFIG_WARNING', error: 'global configuration not published' }] },
    checkpointAudit: { state: 'incomplete', error: 'DB_BUSY' },
    dashboardCopy: { state: 'skipped', reason: 'No protected transaction.' },
    next: 'Resolve the restart error.' };
  for (const json of [false, true]) {
    const script = `
      import { mock } from 'node:test';
      let restartCalls = 0;
      mock.module(${JSON.stringify(new URL('../self-upgrade.js', import.meta.url).href)}, {namedExports: {
        checkForCoreUpdates: () => ({success:true,hasUpdate:true,current:'0.9.0',latest:'0.9.2'}),
        runSelfUpgrade: () => (${JSON.stringify(result)}),
        downloadCoreToTemp: () => ({success:true,tempDir:${JSON.stringify(root)}}),
        readChangelog: () => '', cleanupTemp() {}, cleanupBackup() {}
      }});
      mock.module(${JSON.stringify(new URL('../request-runtime-restart.js', import.meta.url).href)}, {namedExports: {
        requestRuntimeRestart: () => { restartCalls++; return {ok:true}; }
      }});
      process.on('exit', () => process.stderr.write('restartCalls=' + restartCalls));
      const {upgradeComponent} = await import(${JSON.stringify(modulePath)});
      await upgradeComponent(['--self','--yes',...(${json} ? ['--json'] : [])]);
    `;
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
      { encoding: 'utf8', env: { ...process.env, ZYLOS_DIR: root } });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stderr, /restartCalls=0/);
    const output = json ? JSON.parse(child.stdout).reply : child.stdout;
    for (const expected of ['Installation: done', 'Session restart: manual_required', 'SUBMISSION_FAILED: entry unavailable',
      'Configuration not published (t04): CONFIG_WARNING', 'Checkpoint audit: incomplete: DB_BUSY',
      'Dashboard database: not copied', result.next]) assert.ok(output.includes(expected), output);
    assert.doesNotMatch(output, /No action needed|restart automatically/);
  }
});

test('self upgrade and forward repair accept integer seconds with the same default budget', () => {
  for (const command of ['--self', '--resume-finalize']) {
    assert.equal(parseUpgradeFinalizeOptions([command]).finalizeTimeoutMs, 600000);
    for (const seconds of ['60', '900', '3600']) {
      const parsed = parseUpgradeFinalizeOptions([command, '--finalize-timeout', seconds, '--json']);
      assert.equal(parsed.finalizeTimeoutMs, Number(seconds) * 1000);
      assert.equal(parsed.timeout, seconds);
    }
  }
  assert.equal(parseUpgradeFinalizeOptions(['--resume-finalize', '--status', '--json']).status, true);
});

test('invalid timeout forms and incompatible commands are rejected', () => {
  const cases = [
    ['--status'], ['--self', '--status'],
    ['--resume-finalize', '--self'], ['--resume-finalize', '--check'],
    ['--resume-finalize', '--branch', 'main'], ['--resume-finalize', 'component'],
    ['--self', '--finalize-timeout'], ['--resume-finalize', '--finalize-timeout'],
    ['--self', '--finalize-timeout=60'],
    ['--self', '--finalize-timeout', '60', '--finalize-timeout', '900'],
    ...['59', '3601', '60.5', 'abc', '-60', 'Infinity'].map(value => ['--self', '--finalize-timeout', value]),
    ...[['--self', '--check'], ['--all'], ['example'], ['--resume-finalize', '--status']]
      .map(command => [...command, '--finalize-timeout', '600']),
  ];
  for (const args of cases) assert.throws(() => parseUpgradeFinalizeOptions(args), { code: 'INVALID_ARGS' }, args.join(' '));
});

test('invalid status budget fails before discovering corrupt transaction material or writing files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-cli-invalid-'));
  try {
    fs.mkdirSync(path.join(root, '.zylos'));
    fs.writeFileSync(path.join(root, '.zylos', 'upgrade-maintenance.json'), '{corrupt');
    const before = fs.readdirSync(root, { recursive: true });
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const {upgradeComponent}=await import(${JSON.stringify(modulePath)});await upgradeComponent(['--resume-finalize','--status','--finalize-timeout','600','--json']);`],
    { encoding: 'utf8', env: { ...process.env, ZYLOS_DIR: root } });
    assert.equal(child.status, 1, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { ok: false, error: {
      code: 'INVALID_ARGS', message: '--finalize-timeout requires --self or --resume-finalize, without --check or --status.', persisted: [],
    } });
    assert.deepEqual(fs.readdirSync(root, { recursive: true }), before);
    assert.equal(fs.readFileSync(path.join(root, '.zylos', 'upgrade-maintenance.json'), 'utf8'), '{corrupt');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resume without a protected transaction reports NOT_RESUMABLE and preserves the instance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-cli-empty-'));
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const {upgradeComponent}=await import(${JSON.stringify(modulePath)});await upgradeComponent(['--resume-finalize','--status','--json']);`],
    { encoding: 'utf8', env: { ...process.env, ZYLOS_DIR: root } });
    assert.equal(child.status, 1, child.stderr);
    const output = JSON.parse(child.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.code, 'NOT_RESUMABLE');
    assert.deepEqual(output.error.persisted, []);
    assert.equal(Object.hasOwn(output, 'data'), false);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('forward repair output retains partial results and identifies unpublished warning targets', () => {
  const output = formatFinalizeResult({ ok: false, error: { code: 'FINALIZE_INCOMPLETE', message: 'service start failed' }, data: {
    transactionId: 'upgrade-fixture', core: { state: 'failed', failedItems: [{ id: 'step7', code: 'PM2_TIMEOUT' }],
      warnings: [{ targetId: 't03', code: 'codex_config_reconcile_failed', error: 'configuration not published' }] },
    dashboard: { state: 'degraded', errors: [{ item: 'route', code: 'reload_failed' }] },
    next: 'Repair PM2 and run zylos upgrade --resume-finalize.',
  } });
  for (const expected of ['FINALIZE_INCOMPLETE: service start failed', 'Core: failed', 'step7: PM2_TIMEOUT',
    't03: codex_config_reconcile_failed: configuration not published', 'Dashboard: degraded', 'route: reload_failed', '--resume-finalize']) {
    assert.ok(output.includes(expected), expected);
  }
});
