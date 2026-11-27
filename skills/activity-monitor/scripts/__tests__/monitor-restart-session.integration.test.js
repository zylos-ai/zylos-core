import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { main } from '../monitor.js';
import { startSupervisor } from '../supervisor-main.js';
import { SupervisorScenes } from '../supervisor-scenes.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';

// Boundary: the real monitor entry and Supervisor stop/start against a live agent
// session on a private tmux socket. The runtime is a sleeper process, the PM2
// signal is an injected emitter, and the loop timer is never scheduled: no PM2,
// network or model is used. Run for monitor shutdown/startup or Supervisor stop
// changes; unrelated UI work may skip. Official runner isolates HOME/ZYLOS_DIR/
// PM2_HOME/short TMPDIR; readyTmuxTarget owns and cleans the tmux server and DB.
test('ordinary monitor restart preserves the agent tmux session', { timeout: 20000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'monitor-restart-', mode: 'multi', runtimeProcess: true });
  const readMode = () => ({ mode: 'multi', keyPresent: true });
  const store = createStore(f.db, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
  const identity = () => f.tmux('display-message', '-p', '-t', '=zylos-group-origin:', '#{session_id}:#{pane_id}:#{pane_pid}:#{session_created}');
  const before = identity();
  async function monitor() {
    const scenes = new SupervisorScenes({ env: f.env, connectionOptions: { socketPath: f.socketPath, binary: f.binary },
      readMode, readActivity: () => ({ state: 'idle', idleSince: 1 }), readUsage: () => null });
    const signals = new EventEmitter(), exits = [];
    const exited = new Promise(resolve => { signals.exit = code => { exits.push(code); resolve(); }; });
    const service = await main({ runtime: signals, log: () => {}, start: () => startSupervisor({ env: f.env,
      db: { ...store, getDb: () => f.db }, scenes, readMode, readConfiguration: () => ({ mode: 'multi', runtime: 'claude', capacity: 2 }),
      resolveTargetRuntime: () => 'claude',
      machineTasks: { tick() {}, stop() {} }, legacyStatus: { tick() {}, close() {} },
      sendAlert: () => { throw new Error('external send forbidden'); }, log: () => {},
      loopOptions: { schedule: () => 1, cancel: () => {} } }) });
    await service.supervisor.loop.tick();
    const scene = await scenes.observeGroup('origin');
    assert.equal(scene.present, true); assert.equal(scene.runId, 'run-1');
    return { restart: async () => { signals.emit('SIGTERM'); await exited; assert.deepEqual(exits, [0]); } };
  }
  await (await monitor()).restart();
  assert.equal(identity(), before, 'stopping the monitor must not end or replace the agent session');
  await (await monitor()).restart();
  assert.equal(identity(), before, 'the restarted monitor must adopt the same agent session');
});
