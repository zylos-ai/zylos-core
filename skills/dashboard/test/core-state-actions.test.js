import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectOrigin } from '../src/lib/core-state.js';
import { buildRestartStatus, handleCoreAction } from '../src/lib/core-actions.js';
import { Sanitizer } from '../src/lib/sanitizer.js';
import { formatActionResult } from '../public/js/action-result.js';
import { pendingDepthValue, sessionBlockTitleKey, stateTitleKey } from '../public/js/state-presentation.js';

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

test('state and queue presentation keep startup and read failures visible', () => {
  assert.equal(stateTitleKey('STARTING'), 'state.starting');
  assert.equal(stateTitleKey('OFFLINE'), 'state.offline');
  assert.equal(pendingDepthValue(0), '0');
  assert.equal(pendingDepthValue(null), null);
  assert.equal(pendingDepthValue(undefined), null);
  assert.equal(sessionBlockTitleKey('origin'), 'block.origin');
  assert.equal(sessionBlockTitleKey(null), 'block.single_session');
  assert.equal(sessionBlockTitleKey(undefined), 'block.unknown_session');
});

test('restart status keeps old-run completion separate from current Origin readiness', () => {
  assert.deepEqual(buildRestartStatus(
    '11111111-1111-4111-8111-111111111111',
    'deadline_exceeded',
    { runId: 'R2', sessionId: 'S2', ready: true, state: 'IDLE', identity: { token: 'private' } },
  ), {
    requestId: '11111111-1111-4111-8111-111111111111',
    completion: 'unknown',
    origin: { runId: 'R2', sessionId: 'S2', ready: true, state: 'IDLE' },
  });
});

test('runtime action reads a result returned after ten seconds and restarts Dashboard only for a saved baseline', { timeout: 25000 }, async t => {
  const bin = path.join(process.env.TMPDIR, `dashboard-actions-${process.pid}`);
  fs.mkdirSync(bin, { recursive: true });
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  writeExecutable(path.join(bin, 'zylos'), `const args=process.argv.slice(2),result=process.env.FAKE_RUNTIME_RESULT||'saved';if(args[0]==='runtime'&&result==='saved')setTimeout(()=>console.log(JSON.stringify({ok:true,data:{result}})),10200);else console.log(JSON.stringify({ok:true,data:{result}}));`);
  const pm2Log = path.join(process.env.TMPDIR, `dashboard-pm2-${process.pid}.log`);
  writeExecutable(path.join(bin, 'pm2'), `require('node:fs').appendFileSync(process.env.FAKE_PM2_LOG,JSON.stringify(process.argv.slice(2))+'\\n');`);
  const previous = { PATH: process.env.PATH, FAKE_RUNTIME_RESULT: process.env.FAKE_RUNTIME_RESULT, FAKE_PM2_LOG: process.env.FAKE_PM2_LOG };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_PM2_LOG = pm2Log;
  fs.mkdirSync(path.join(process.env.ZYLOS_DIR, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(process.env.ZYLOS_DIR, '.zylos', 'config.json'), JSON.stringify({ session_mode: 'single' }));
  t.after(() => { process.env.PATH = previous.PATH; for (const key of ['FAKE_RUNTIME_RESULT', 'FAKE_PM2_LOG']) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const config = { zylosDir: process.env.ZYLOS_DIR };
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
