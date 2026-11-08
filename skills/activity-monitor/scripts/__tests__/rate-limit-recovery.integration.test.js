import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { routerFixture, flush } from '../../../comm-bridge/scripts/__tests__/helpers/router-fixture.js';
import { createDelivery } from '../../../comm-bridge/scripts/router/delivery.js';
import { RuntimeHealthCoordinator } from '../runtime-health.js';
import { SupervisorHealthObserver } from '../supervisor-health-observer.js';
import { MessageRouter } from '../message-router.js';

// Boundary: real inbound routing, startup admission, health probe settlement,
// scheduler/delivery and SQLite ledger; fake clock, process launch and probe ACK.
// Run when the registered-start/recovery/delivery handoff changes; unrelated UI
// and transports may skip. The official runner isolates HOME/ZYLOS_DIR/PM2/temp;
// this case opens no tmux/PM2/network, closes its DB and stops both loops below.
for (const recovered of [true, false]) {
  test(`rate-limited inbound ${recovered ? 'recovers and delivers' : 'remains pending after rejected confirmation'}`, { timeout: 10000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-recovery-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.match(path.basename(path.dirname(process.env.HOME)), /^zylos-tests-/);
    assert.ok(!fs.realpathSync(process.env.HOME).startsWith(fs.realpathSync(os.userInfo().homedir) + path.sep));
    assert.ok(process.env.ZYLOS_DIR.startsWith(process.env.HOME + path.sep));
    assert.ok(process.env.PM2_HOME.startsWith(process.env.HOME + path.sep));
    assert.ok(root.startsWith(os.tmpdir() + path.sep));
    t.diagnostic(JSON.stringify({ isolationBeforeOpen: { home: process.env.HOME, zylosDir: process.env.ZYLOS_DIR,
      pm2: process.env.PM2_HOME, tmp: os.tmpdir(), root, database: ':memory:', tmux: 'none', network: 'none' } }));
    const f = routerFixture(t);
    const listScenes = () => [...f.scene].map(([sessionGroup, scene]) => ({ ...scene, sessionGroup, processRunning: true }));
    const health = new RuntimeHealthCoordinator({ zylosDir: root, now: f.now, readMode: () => 'multi',
      resolveTargetRuntime: () => 'claude', listScenes });
    const observer = new SupervisorHealthObserver({ coordinator: health, now: f.now, readMode: () => 'multi', listScenes,
      readIdentity: group => f.scene.get(group), readState: () => ({ state: 'idle', tools: [] }),
      readScreen: () => recovered ? '' : 'rate limit', matchScreen: () => ({ rateLimit: { detected: !recovered } }),
      buildTargetBinding: scene => ({ expectedRunId: scene.runId,
        tmuxTarget: { serverGeneration: 'isolated-server', sessionId: '$1', paneId: '%1' } }),
      insertControl: (content, options) => f.db.insertControl(content, { ...options, appendAckSuffix: false }),
      getControlById: f.db.getControlById, stop: () => assert.fail('rate limiting must not stop the scene') });
    t.after(() => observer.shutdown());
    health.probeInFlight = runtime => observer.probeInFlight(runtime);
    const router = new MessageRouter({ healthCoordinator: health, now: f.now, resolveTargetRuntime: () => 'claude',
      cacheDirectory: path.join(root, 'cache'), requestProbe: runtime => observer.requestProbe(runtime) });
    health.readNegativeCache = runtime => router.readNegativeCache(runtime);
    health.clearNegativeCache = runtime => router.clearCache(runtime);
    const oldIdentity = { runtime: 'claude', session_id: 'old-session', claude_pid: 44 };
    const hook = await health.consumeHook('claude', { schema_version: 1, source: 'hook', ...oldIdentity,
      event_id: randomUUID(), prompt_id: 'old-prompt', event: 'stop_failure', error: 'rate_limit', received_at: f.now() },
    { identity: oldIdentity, sessionGroup: 'chat' });
    assert.equal(hook.status, 'processed');
    assert.equal(hook.state.health, 'rate_limited');
    const state = health.store('claude').read();
    Object.assign(state.scheduling, { cooldownUntil: 0, restartFailureCount: 1, lastRecoveryAt: f.now() / 1000 - 100 });
    health.store('claude').write(state);
    const initial = health.store('claude').read();
    assert.equal(initial.scheduling.cooldownUntil, 0);
    assert.equal(initial.scheduling.rateLimitResetTime, '');
    f.deps.randomUUID = randomUUID;
    f.deps.readRuntimeHealth = runtime => health.store(runtime).read();
    f.deps.submit = async request => {
      const reply = await health.registerStartAttempt(request);
      return { kind: reply.ok ? 'accepted' : 'rejected', sent: true, reply };
    };
    let pastes = 0;
    const originalAdapter = f.deps.getSessionAdapter;
    f.deps.getSessionAdapter = runtime => ({ ...originalAdapter(runtime),
      sendText: async () => { pastes++; }, sendKeys: async () => {}, captureScreen: async () => '❯ ' });
    const delivery = createDelivery({ ...f.deps, getSessionMode: () => 'multi', now: f.now,
      sleep: async ms => f.advance(ms),
      openTmuxConnection: async () => ({ close: async () => {}, command: async () => '0' }),
      resolveSessionTarget: async ({ sessionGroup }) => f.scene.get(sessionGroup), revalidateSessionTarget: async () => {},
      readSessionState: async group => ({ identity: f.scene.get(group), status: { valid: true,
        value: { state: 'idle', health: health.store('claude').read().health, idle_seconds: 10 } } }),
      formatConversation: row => row.content, notifyDelivered: () => {} }, { periodicEnabled: false, captureEnabled: false });
    t.after(() => delivery.stop());
    Object.assign(f.deps, { deliverConversation: delivery.deliverConversation, canAttemptDelivery: delivery.canAttempt,
      finishDeliveryWait: delivery.finishWait, sweepDeliveryWaits: delivery.sweepWaits });
    if (!recovered) f.deps.deliverControl = async row => {
      f.sqlite.prepare("UPDATE control_queue SET status='failed' WHERE id=? AND status='running'").run(row.id);
    };
    await f.create().initialize();
    const sentAt = f.now();
    const response = await router.route({ version: 2, type: 'route', requestId: 'inbound', noReply: false,
      channel: 'dashboard', endpoint: 'chat', componentName: 'dashboard', sessionGroup: 'chat', receivedAt: sentAt });
    assert.equal(response.decision, 'pending');
    const row = f.add('chat');
    f.advance(3000);
    await f.rounds(3);
    assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1,
      JSON.stringify({ events: f.events.slice(-8), calls: f.calls.slice(-8) }));
    assert.equal(health.store('claude').read().scheduling.restartFailureCount, 2);
    assert.equal(pastes, 0, 'a ready process alone must not release business messages');
    const probe = observer.requestProbe('claude');
    for (let i = 0; i < 30 && [...observer.probes.values()].some(item => item.preparing); i++) await flush();
    if (!observer.probes.size) assert.fail(JSON.stringify({ probe: await probe, association: health.registeredAttempt('claude'), scenes: listScenes() }));
    assert.equal(observer.probes.size, 1);
    assert.equal([...observer.probes.values()][0].preparing, false);
    await f.rounds(2); await observer.tick();
    assert.equal((await probe).recovered, recovered);
    for (let i = 0; i < (recovered ? 35 : 600); i++) {
      if (recovered && f.row(row.id).status === 'delivered') break;
      f.advance(1000); await f.rounds();
    }
    assert.equal(f.row(row.id).status, recovered ? 'delivered' : 'pending');
    assert.equal(pastes, recovered ? 1 : 0);
    const waits = f.events.filter(event => event.event === 'delivery_deferred');
    assert.equal(waits.length, 1, 'same message and reason must log only the first wait');
    assert.equal(waits[0].code, 'session_unhealthy');
    if (recovered) assert.ok(f.now() - sentAt < 35000);
    else assert.equal(health.store('claude').read().health, 'rate_limited');
    t.diagnostic(JSON.stringify({ recovered, elapsedMs: f.now() - sentAt,
      waitLogLines: waits.length, deliveryLogLines: f.events.filter(event => event.event === 'deliver').length,
      isolation: { home: process.env.HOME, zylosDir: process.env.ZYLOS_DIR, pm2: process.env.PM2_HOME,
        tmp: os.tmpdir(), database: ':memory:', tmux: 'none', network: 'none' } }));
  });
}
