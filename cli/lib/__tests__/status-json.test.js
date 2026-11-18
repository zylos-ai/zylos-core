import assert from 'node:assert/strict';
import test from 'node:test';
import { collectStatus } from '../status-view.js';
import { showStatus } from '../../commands/service.js';
import { attachCommand } from '../../commands/attach.js';
import { describeOrigin, formatOriginDescription } from '../origin-presence.js';

const time = Date.parse('2026-11-17T01:02:03.000Z');
const fixture = (overrides = {}) => ({
  mode: () => ({ mode: 'multi' }), list: () => [],
  session: () => ({ identity: { present: true, ready: true, runtime: 'codex', runId: 'run', sessionId: 'session' },
    status: { valid: true, reason: null, sampledAt: time, value: { state: 'idle', idle_seconds: 4 } } }),
  health: () => ({ health: 'ok', publicHealth: 'ok', cooldownUntil: null, updatedAt: time }),
  now: () => time, configIssue: () => null, resolveRoot: () => {}, requests: () => [],
  facts: () => ({ originNeed: { inbound: 0, controls: 0, continuation: false, oldestAt: null } }),
  ...overrides,
});

async function capture(data, args) {
  const log = console.log, lines = [];
  console.log = line => lines.push(line);
  try {
    const result = await showStatus(args, { collect: () => data,
      host: () => ({ services: [], disk: null }), alertNotice: () => ({ kind: 'ready' }),
      resolveRuntime: () => 'codex' });
    return { result, lines };
  } finally { console.log = log; }
}

// sessionMode is the strictly read value: null for a configuration without session_mode
// (pre-migration instance), 'unreadable' when it cannot be read; view lists sessions accordingly.
for (const [name, overrides, expectedMode, expectedView] of [
  ['normal', {}, 'multi', 'multi'],
  ['missing health', { health: runtime => runtime === 'codex' ? { missing: true }
    : { health: 'auth_failed', publicHealth: 'auth_failed', cooldownUntil: null, updatedAt: time } }, 'multi', 'multi'],
  ['pre-migration session mode', { mode: () => ({ mode: null }) }, null, 'single'],
  ['native single session mode', { mode: () => ({ mode: 'single' }) }, 'single', 'single'],
  ['unreadable session mode', { mode: () => { throw Error('unreadable config'); } }, 'unreadable', 'multi'],
]) {
  test(`status JSON projects ${name} without changing internal status or text`, async () => {
    const data = await collectStatus(fixture(overrides));
    const before = structuredClone(data);
    const textBefore = await capture(data, []);
    const { result, lines } = await capture(data, ['--json']);
    assert.equal(lines.length, 1);
    const wire = JSON.parse(lines[0]);
    assert.deepEqual(wire, result);
    assert.equal(wire.ok, true);
    assert.equal(wire.data.sessionMode, expectedMode);
    assert.equal(wire.data.view, expectedView);
    assert.equal(wire.data.readAt, '2026-11-17T01:02:03.000Z');
    assert.equal(wire.data.origin.presence, 'running');
    assert.equal(wire.data.origin.runId, 'run');
    assert.equal(wire.data.origin.sessionId, 'session');
    assert.equal(wire.data.origin.status.state, 'idle');
    for (const runtime of ['claude', 'codex']) {
      const original = before.runtimeHealth[runtime];
      assert.equal(wire.data.runtimeHealth[runtime].source, original.source);
      assert.equal(wire.data.runtimeHealth[runtime].health, original.source === 'missing' ? null : original.health);
      assert.equal(wire.data.runtimeHealth[runtime].publicHealth, original.source === 'missing' ? null : original.publicHealth);
    }
    assert.deepEqual(data, before, 'collectStatus values shared by attach and doctor stay unchanged');
    assert.equal(typeof data.readAt, 'number');
    assert.equal(Math.floor(data.readAt / 1000), 1794877323);
    if (name === 'missing health') assert.equal(data.runtimeHealth.codex.health, 'ok');
    assert.deepEqual((await capture(data, [])).lines, textBefore.lines);
  });
}

test('status JSON preserves absent and unreadable nullable fields', async () => {
  const data = await collectStatus(fixture({
    session: () => ({ identity: { present: false }, status: { valid: false, reason: 'not_running', sampledAt: null } }),
    health: () => ({ unreadable: true }),
  }));
  const wire = (await capture(data, ['--json'])).result.data;
  assert.equal(wire.origin.presence, 'not_running');
  for (const field of ['runId', 'sessionId']) assert.equal(wire.origin[field], null);
  assert.equal(wire.origin.status.state, null);
  for (const runtime of ['claude', 'codex']) {
    assert.equal(wire.runtimeHealth[runtime].source, 'unreadable');
    assert.equal(wire.runtimeHealth[runtime].health, null);
    assert.equal(wire.runtimeHealth[runtime].publicHealth, null);
  }
});

test('status JSON does not change the Origin interpretation used by attach and doctor', async () => {
  const data = await collectStatus(fixture({
    session: () => ({ identity: { present: false }, status: { valid: false, reason: 'not_running', sampledAt: null } }),
    health: () => ({ missing: true }),
    facts: () => ({ originNeed: { inbound: 1, controls: 0, continuation: false, oldestAt: time / 1000 - 301 } }),
  }));
  const describe = () => describeOrigin({ ...data, targetRuntime: 'codex', nowSec: Math.floor(data.readAt / 1000) });
  const before = describe();
  assert.equal(before.state, 'wake_overdue');
  const expected = formatOriginDescription(before, 'codex', data.originNeed);
  await capture(data, ['--json']);
  assert.deepEqual(describe(), before, 'doctor consumes the same raw clock and health');
  const exit = process.exit, error = console.error, lines = [];
  process.exit = code => { assert.equal(code, 1); throw Error('fixture exit'); };
  console.error = line => lines.push(line);
  try {
    await assert.rejects(attachCommand({
      resolve: () => ({ sessionGroup: 'origin', runtime: 'codex', live: { tmuxName: 'fixture-origin' } }),
      exec: () => { throw Error('fixture session absent'); }, collect: () => data,
    }), /fixture exit/);
    assert.deepEqual(lines, [expected]);
  } finally { process.exit = exit; console.error = error; }
});

test('status JSON failure envelope includes a machine-readable code', async () => {
  const exit = process.exitCode, log = console.log, lines = [];
  console.log = line => lines.push(line);
  try {
    const result = await showStatus(['--json'], { collect: () => { throw Error('fixture read failure'); }, configIssue: () => null });
    assert.deepEqual(JSON.parse(lines[0]), result);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'STATUS_UNAVAILABLE');
    assert.equal(typeof result.error.message, 'string');
    assert.equal('data' in result, false);
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = exit; console.log = log; }
});
