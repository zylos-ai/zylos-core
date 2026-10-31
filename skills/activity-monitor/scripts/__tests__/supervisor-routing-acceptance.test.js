import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { tmuxNameForGroup } from '../../../../cli/lib/session-group-paths.js';
import { SupervisorScenes } from '../supervisor-scenes.js';
import { startSupervisor } from '../supervisor-main.js';

// A-D and unbound: actual supervisor entry resolver and adapter observations on
// the shared isolated tmux fixture. No native authenticated runtime is used.
async function routingFixture(t, wrongConfig = false) {
  const f = readyTmuxTarget(t, { prefix: 'supervisor-routing-', mode: 'multi', runtimeProcess: true });
  const executable = path.join(f.root, 'codex');
  fs.copyFileSync(path.join(f.root, 'claude'), executable);
  for (const [group, config, command] of [
    ['lark:a', { runtime: 'codex', mode: 'default' }, executable],
    ['lark:c', null, executable], ['lark:d', null, '/bin/sleep'],
  ]) {
    f.tmux('new-session', '-d', '-s', tmuxNameForGroup(group), '-e', `ZYLOS_SESSION_GROUP=${group}`,
      '-e', `ZYLOS_RUN_ID=run-${group}`, ...(config ? ['-e', `ZYLOS_MODEL_CONFIG=${JSON.stringify(config)}`] : []), command, '120');
  }
  const configReads = [];
  const db = { getModeTransition: () => null, getDrainFence: () => null,
    listDrainFences: () => [], listPendingSessionGroups: () => [],
    resolveSessionLaunchConfig: input => { configReads.push(input); return { runtime: 'claude', mode: 'default' }; } };
  const scenes = new SupervisorScenes({ env: f.env, connectionOptions: { socketPath: f.socketPath, binary: f.binary },
    readMode: () => ({ mode: 'multi' }) });
  // The test isolates resolution from automatic lifecycle policy. The default
  // entry resolver still reads the actual adapter and the supplied database.
  scenes.observe = async () => [];
  const service = await startSupervisor({ env: f.env, db, scenes,
    readMode: () => ({ mode: 'multi' }), readConfiguration: () => ({ mode: 'multi', runtime: 'claude', capacity: 5 }),
    machineTasks: { tick() {}, stop() {} }, legacyStatus: { tick() {}, close() {} }, log: () => {},
    loopOptions: { schedule: () => 1, cancel() {} },
    ...(wrongConfig ? { resolveTargetRuntime: group => db.resolveSessionLaunchConfig({ sessionGroup: group }).runtime } : {}),
  });
  t.after(() => service.stop());
  const route = group => service.supervisor.router.route({ version: 2, type: 'route', requestId: `route-${group}`,
    channel: 'lark', endpoint: 'isolated', componentName: null, sessionGroup: group, noReply: true, receivedAt: 1000 });
  return { route, configReads, removeOrigin: () => f.tmux('kill-session', '-t', '=zylos-group-origin') };
}

test('actual entry selects live snapshot/process over new config, preserves unknown, resolves absent and unbound', { timeout: 15000 }, async t => {
  const f = await routingFixture(t);
  for (const group of ['lark:a', 'lark:c']) {
    const result = await f.route(group); assert.equal(result.runtime, 'codex'); assert.notEqual(result.observation, 'runtime_unknown');
  }
  const unknown = await f.route('lark:d');
  assert.equal(unknown.runtime, 'unknown'); assert.equal(unknown.observation, 'runtime_unknown'); assert.equal(unknown.decision, 'pending');
  assert.equal(f.configReads.length, 0);
  assert.equal((await f.route('lark:b')).runtime, 'claude');
  f.removeOrigin();
  assert.equal((await f.route(null)).runtime, 'claude');
  assert.deepEqual(f.configReads.map(row => row.sessionGroup), ['lark:b', null]);
});

test('live-runtime assertions reject a configured-runtime-only resolver', { timeout: 15000 }, async t => {
  const f = await routingFixture(t, true);
  for (const group of ['lark:a', 'lark:c']) {
    await assert.rejects(async () => assert.equal((await f.route(group)).runtime, 'codex'), { code: 'ERR_ASSERTION' });
  }
});
