import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectGroup } from '../src/lib/workbench/groups-api.js';
import { projectOrigin } from '../src/lib/core-state.js';
import { handleCoreAction } from '../src/lib/core-actions.js';
import { Sanitizer } from '../src/lib/sanitizer.js';
import { formatActionResult } from '../public/js/action-result.js';

const writeExecutable = (file, body) => { fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 }); };
const translate = (key, params = {}) => `${key} ${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(' ')}`.trim();

test('Origin projection distinguishes startup and absence without exposing raw tool input', () => {
  const sanitizer = new Sanitizer(process.env.ZYLOS_DIR);
  const starting = projectOrigin('origin', {
    identity: { present: true, ready: false, runId: 'R1', sessionId: null, runtime: 'claude', launchConfig: { token: 'private' } },
    status: { valid: false, reason: 'starting', sampledAt: null }, usage: { valid: false },
  }, sanitizer);
  assert.equal(starting.state, 'STARTING');
  assert.equal(starting.ready, false);
  assert.equal('identity' in starting, false);
  assert.equal('usage' in starting, false);

  const offline = projectOrigin('origin', { identity: { present: false, runtime: 'unknown' }, status: { valid: false, reason: 'not_running' }, usage: { valid: false } }, sanitizer);
  assert.equal(offline.state, 'OFFLINE');

  const replaced = projectOrigin('origin', {
    identity: { present: true, ready: true, runId: 'R-old', sessionId: 'S-old', runtime: 'claude' },
    status: { valid: false, reason: 'identity_changed', sampledAt: 1 }, usage: { valid: false },
  }, sanitizer);
  assert.equal(replaced.state, 'UNKNOWN');
  assert.equal(replaced.runId, null);
  assert.equal(replaced.sessionId, null);
  assert.equal(replaced.ready, false);

  const busy = projectOrigin('origin', {
    identity: { present: true, ready: true, runId: 'R2', sessionId: 'S2', runtime: 'claude' },
    status: { valid: true, reason: null, sampledAt: 1, value: { state: 'busy', active_tool_details: [{ id: 'T1', name: 'Bash', startedAt: 1, input: { command: 'curl -H "Authorization: Bearer abc.def.secret" https://example.test' } }] } },
    usage: { valid: true, value: { model: { id: 'safe' } } },
  }, sanitizer);
  const serialized = JSON.stringify(busy);
  assert.equal(busy.running_tools[0].tool_detail.includes('[REDACTED]'), true);
  assert.equal(serialized.includes('abc.def.secret'), false);
  assert.equal(serialized.includes('active_tool_details'), false);
});

test('control result formatter lists every id and explicit rejection code', () => {
  const success = formatActionResult({ messageKey: 'result.controls_submitted', steps: [
    { controlId: 41, submission: 'submitted' }, { controlId: 42, submission: 'submitted' },
  ] }, translate);
  assert.match(success, /id=41/i); assert.match(success, /id=42/i);
  const rejected = formatActionResult({ steps: [{ controlId: null, submission: 'rejected', rejectionCode: 'DB_BUSY' }] }, translate);
  assert.match(rejected, /submission_rejected/); assert.match(rejected, /DB_BUSY/);
});


test('Core state enforces readiness, freshness and runtime-specific account usage', async t => {
  const calls = [];
  let observation = {
    identity: { present: true, ready: true, runId: 'R-codex', sessionId: 'S-codex', runtime: 'codex' },
    status: { valid: true, reason: null, sampledAt: Date.now(), value: { state: 'idle' } },
    usage: { valid: false, reason: 'missing' },
  };
  const reader = {
    readSessionStates: async (groups, options) => { calls.push({ type: 'state', groups, options }); return new Map(groups.map(group => [group, structuredClone(observation)])); },
    resolveTargetRuntime: async () => 'codex',
    readRuntimeHealth: () => ({ health: 'ok' }),
    readAccountUsageSnapshot: async runtime => {
      calls.push({ type: 'account', runtime });
      return { recorded: { value: runtime === 'codex' ? { five_hour: { used_percentage: 23 } } : { five_hour: { used_percentage: 91 } }, live: true, recordedAt: Date.now() } };
    },
  };
  t.mock.module('../src/lib/core-modules.js', { namedExports: { loadCoreModule: async name => {
    if (name === 'config.js') return { readSessionMode: () => ({ mode: 'multi', keyPresent: true }) };
    if (name === 'session-group-paths.js') return { listGroupTmuxSessions: async () => [{ sessionGroup: 'origin' }] };
    assert.fail(`Unexpected core module ${name}`);
  } } });
  const { CoreState } = await import(`../src/lib/core-state.js?contracts=${Date.now()}`);
  const core = new CoreState({ zylosDir: process.env.ZYLOS_DIR, sessionObservations: {
    reader, get: async () => ({ mode: 'multi', group: 'origin', reader, observations: await reader.readSessionStates(['origin'], { freshnessMs: 5000, includeAllLive: true }) }),
    resolveOfflineRuntime: async () => 'codex',
  } });
  const state = await core.refresh();
  assert.deepEqual(calls.find(call => call.type === 'state'), { type: 'state', groups: ['origin'], options: { freshnessMs: 5000, includeAllLive: true } });
  assert.deepEqual(calls.find(call => call.type === 'account'), { type: 'account', runtime: 'codex' });
  assert.equal(core.accountUsage.five_hour.used_percentage, 23);
  assert.equal(state.state, 'IDLE');
  observation = { ...observation, identity: { ...observation.identity, ready: false } };
  await assert.rejects(core.currentTarget(), error => error.code === 'target_unavailable');
});

// Covers target selection and C4 acceptance with a private database; no runtime is contacted.
test('Origin interrupt and nudge use configured scopes accepted by C4', async t => {
  const { fileURLToPath } = await import('node:url');
  const Database = (await import('better-sqlite3')).default;
  const { ZYLOS_DIR } = await import('../../../cli/lib/config.js');
  const configDir = path.join(ZYLOS_DIR, '.zylos');
  const script = path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-control.js');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.symlinkSync(fileURLToPath(new URL('./helpers/origin-control-child.js', import.meta.url)), script);
  for (const session_mode of ['single', 'multi', undefined]) {
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ session_mode }));
    const detail = projectGroup({ sessionGroup: session_mode ? 'origin' : null,
      presence: 'running', live: { runId: 'observed-run', sessionId: 'observed-session', status: { valid: true, state: 'idle' } } },
    { readAt: Date.now(), instance: { sessionModeStatus: { sessionMode: session_mode ?? null } } });
    const sessionGroup = session_mode ? 'origin' : null;
    assert.equal(detail.sessionGroup, sessionGroup);
    const body = { sessionGroup: detail.sessionGroup, runId: detail.live.runId, sessionId: detail.live.sessionId };
    for (const action of ['interrupt', 'chop-chop']) {
      const result = await handleCoreAction(action, body, { zylosDir: ZYLOS_DIR });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.submission, 'submitted');
      const db = new Database(path.join(ZYLOS_DIR, 'controls.db'), { readonly: true });
      try {
        const row = db.prepare('SELECT session_group FROM control_queue WHERE id=?').get(result.controlId);
        assert.equal(row.session_group, sessionGroup);
      } finally { db.close(); }
    }
    const mismatch = await handleCoreAction('interrupt', { sessionGroup: sessionGroup === null ? 'origin' : null, runId: 'observed-run' }, { zylosDir: ZYLOS_DIR });
    assert.equal(mismatch.error, 'TARGET_SCOPE_MISMATCH');
  }
});

test('runtime action reads a result returned after ten seconds and restarts Dashboard only for a saved baseline', { timeout: 25000 }, async t => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR, 'dashboard-actions-'));
  const zylosDir = path.join(root, 'zylos');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeExecutable(path.join(bin, 'zylos'), `const args=process.argv.slice(2),result=process.env.FAKE_RUNTIME_RESULT||'saved';if(args[0]==='runtime'&&result==='saved')setTimeout(()=>console.log(JSON.stringify({ok:true,data:{result}})),10200);else console.log(JSON.stringify({ok:true,data:{result}}));`);
  const pm2Log = path.join(root, 'pm2.log');
  writeExecutable(path.join(bin, 'pm2'), `require('node:fs').appendFileSync(process.env.FAKE_PM2_LOG,JSON.stringify(process.argv.slice(2))+'\\n');`);
  const previous = { PATH: process.env.PATH, ZYLOS_DIR: process.env.ZYLOS_DIR, FAKE_RUNTIME_RESULT: process.env.FAKE_RUNTIME_RESULT, FAKE_PM2_LOG: process.env.FAKE_PM2_LOG };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.ZYLOS_DIR = zylosDir;
  process.env.FAKE_PM2_LOG = pm2Log;
  fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, '.zylos', 'config.json'), JSON.stringify({ session_mode: 'single' }));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const config = { zylosDir };
  const saved = await handleCoreAction('switch-runtime', { runtime: 'codex' }, config);
  assert.equal(saved.ok, true); assert.equal(saved.data.result, 'saved'); assert.equal(saved.detached, true);
  for (let attempt = 0; attempt < 30 && !fs.existsSync(pm2Log); attempt += 1) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(fs.readFileSync(pm2Log, 'utf8').trim().split('\n').map(JSON.parse), [['restart', 'zylos-dashboard']]);
  process.env.FAKE_RUNTIME_RESULT = 'unchanged';
  const unchanged = await handleCoreAction('switch-runtime', { runtime: 'codex' }, config);
  assert.equal(unchanged.detached, false); assert.equal(unchanged.messageKey, 'result.runtime_unchanged');
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(fs.readFileSync(pm2Log, 'utf8').trim().split('\n').length, 1);
  const mode = await handleCoreAction('switch-mode', { mode: 'multi' }, config);
  assert.equal(mode.ok, true); assert.equal(mode.data.result, 'unchanged');
});
