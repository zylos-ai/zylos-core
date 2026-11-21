import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { collectHealthHook } from '../skills/activity-monitor/scripts/hook-health.js';
import * as failureNotices from '../skills/comm-bridge/scripts/first-failure-notice.js';
import { fixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { groupRunDir } from '../cli/lib/session-group-paths.js';

async function finishRound(round) {
  let timeout;
  try {
    await Promise.race([round, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Supervisor round waited for the held authentication probe')), 1500);
    })]);
  } finally {
    clearTimeout(timeout);
  }
}

// Runs the production supervisor entry, full rounds, native event reader,
// status publication, and C4 notice rendering. Run for hook auth, notice, or
// publication changes and skip for unrelated runtime and UI changes. Uses the
// isolated Node runner with private HOME, ZYLOS_DIR, PM2_HOME and short TMPDIR,
// a private AM socket and an in-memory C4 database. No tmux, model CLI or
// channel process runs. Reclaims the socket, supervisor and files on failure.
test('Claude StopFailure confirmation leaves the supervisor free to publish other sessions', { timeout: 15000 }, async t => {
  const noticeFixtures = new Map();
  t.mock.module('../skills/comm-bridge/scripts/first-failure-notice.js', {
    namedExports: {
      ...failureNotices,
      drainFirstFailureNotices(options) {
        const capture = noticeFixtures.get(options.zylosDir);
        const work = failureNotices.drainFirstFailureNotices({
          ...options,
          reserve: (_channel, endpoint) => ({ endpoint }),
          send: (claim, message) => {
            capture.sent.push({ endpoint: claim.endpoint, message });
            return { outcome: 'sent' };
          },
        });
        capture.work.push(work);
        return work;
      },
    },
  });
  const { startSupervisor } = await import('../skills/activity-monitor/scripts/supervisor-main.js');

  for (const scenario of ['success', 'failure', 'timeout', 'model access', 'replaced run']) {
    await t.test(scenario, async t => {
      const { db, store: c4 } = fixture(t);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
      const env = { ...process.env, ZYLOS_DIR: root };
      const notices = { sent: [], work: [] };
      noticeFixtures.set(root, notices);
      const held = Promise.withResolvers();
      let probe = held.promise, calls = 0, rounds = 0, screenReads = 0, now = Date.now();
      let service;
      const groups = ['first', 'second', 'healthy'].map(endpoint => {
        const sessionGroup = 'telegram:' + endpoint;
        db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group) VALUES ('in','telegram',?,'work','delivered',?)")
          .run(endpoint, sessionGroup);
        return { endpoint, sessionGroup, runDir: groupRunDir(sessionGroup, env), runId: randomUUID(),
          sessionId: randomUUID(), runtime: 'claude', runtimePid: 123, present: true, ready: true,
          processRunning: true, createdAt: now - 1000, launchConfig: { runtime: 'claude', mode: 'default' } };
      });
      const current = [];
      const readIdentity = group => current.find(scene => scene.sessionGroup === group) ?? { present: false };
      const scenes = {
        observe: async () => current.map(scene => ({ ...scene })),
        readIdentity,
        observeGroup: readIdentity,
        listRuns: async () => current,
        readRun: readIdentity,
        readScreen: scene => {
          if (scene.endpoint !== 'first') return '';
          screenReads++;
          return 'Invalid API key';
        },
      };
      // Exercise both publication paths; production batches identity reads.
      if (scenario !== 'failure') scenes.readIdentities = async groups => new Map(groups.map(group => [group, readIdentity(group)]));
      const collect = (scene, errorDetails) => collectHealthHook({
        hook_event_name: errorDetails === undefined ? 'Stop' : 'StopFailure',
        session_id: scene.sessionId, prompt_id: 'p', error: 'authentication_failed', error_details: errorDetails,
      }, { zylosDir: root, nowMs: now, pid: scene.runtimePid,
        env: { ...env, ZYLOS_SESSION_GROUP: scene.sessionGroup, ZYLOS_RUN_ID: scene.runId } });
      const endpoint = name => notices.sent.find(notice => notice.endpoint === name);
      const status = scene => JSON.parse(fs.readFileSync(path.join(scene.runDir, 'agent-status.json'), 'utf8'));

      try {
        const errors = [];
        service = await startSupervisor({
          env, db: { ...c4, getDb: () => db, resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'default' }) }, scenes,
          now: () => now, checkAuth: () => { calls++; return probe; }, log: value => {
            if (value?.error && errors.length === 0) errors.push(value);
          },
          readMode: () => ({ mode: 'multi' }), readConfig: () => ({ session_mode: 'multi', runtime: 'claude' }),
          resolveTargetRuntime: () => 'claude', legacyPresent: () => false,
          readMemoryInputs: () => ({ source: 'host', limitBytes: 8 * 1024 ** 3, usedBytes: 2 * 1024 ** 3 }),
          legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
          loopOptions: { schedule: () => 1, cancel() {} }, afterRound: () => { rounds++; },
        });
        const { supervisor } = service;
        const store = supervisor.health.store('claude');
        const [first, second, healthy] = groups;
        current.push(...groups);
        const modelAccess = scenario === 'model access';
        const failed = scenario === 'failure';
        const failure = collect(first, modelAccess ? 'Your model policy only allows Sonnet.' : 'API Error: 403 Forbidden');
        const healthyStop = collect(healthy);
        if (scenario === 'timeout') collect(second, 'API Error: 403 Forbidden');
        if (!modelAccess) supervisor.observer.notifyDelivered({ ...first, pastedAt: now - 6000 });
        const before = rounds;
        await finishRound(supervisor.loop.tick());
        await Promise.all(notices.work.splice(0));
        assert.equal(rounds, before + 1);
        assert.equal(store.read(healthy.sessionGroup).last_processed.event_id, healthyStop.event_id);
        assert.equal(status(healthy).health, 'ok');
        assert.equal(store.read().health, 'ok');
        assert.equal(calls, modelAccess ? 0 : 1);

        if (!modelAccess) {
          assert.equal(screenReads, 1);
          assert.equal(store.read(first.sessionGroup).last_processed, undefined);
          assert.equal(endpoint(first.endpoint), undefined);
          const answer = failed || scenario === 'replaced run' ? 'failure' : scenario === 'timeout' ? 'uncertain' : 'success';
          if (scenario === 'replaced run') {
            // The replacement reuses the group directory, native session ID and
            // PID. A stale result cannot pass merely by checking the native identity.
            now++;
            current[0] = { ...first, runId: randomUUID() };
          }
          held.resolve({ status: answer });
          await setImmediate();
          const replacementStop = scenario === 'replaced run' ? collect(current[0]) : null;
          await finishRound(supervisor.loop.tick());
          await Promise.all(notices.work.splice(0));
          assert.equal(calls, 1);
          if (replacementStop) {
            assert.equal(store.read(first.sessionGroup).last_processed.event_id, replacementStop.event_id);
            assert.equal(store.read().health, 'ok');
            assert.equal(status(current[0]).health, 'ok');
            assert.equal(endpoint(first.endpoint), undefined);
            assert.equal(errors.length, 0, JSON.stringify(errors[0]));
            return;
          }
          if (scenario === 'timeout') assert.match(endpoint(second.endpoint).message, /reported a failure for this request/);
        }

        assert.equal(store.read(first.sessionGroup).last_processed.event_id, failure.event_id);
        assert.equal(store.read(first.sessionGroup).failure_retry, undefined);
        assert.equal(store.read().health, failed ? 'auth_failed' : 'ok');
        const expected = failed ? /reported an authentication error/ : modelAccess
          ? /current model is unavailable/ : /reported a failure for this request/;
        assert.match(endpoint(first.endpoint).message, expected);
        assert.equal(endpoint(healthy.endpoint), undefined);
        const route = await supervisor.router.route({ version: 2, type: 'route', requestId: 'healthy',
          noReply: false, receivedAt: now, channel: 'telegram', endpoint: healthy.endpoint,
          componentName: 'telegram', sessionGroup: healthy.sessionGroup });
        assert.equal(route.decision, failed ? 'auth_rejected' : 'pending');
        assert.equal(supervisor.health.authTargets('claude').length, 0);
        assert.equal(c4.listDrainFences().length, 0);
        assert.equal(db.prepare('SELECT count(*) FROM control_queue').pluck().get(), 0);
        if (failed) {
          probe = Promise.resolve({ status: 'success' });
          await supervisor.router.notifyAuthCompleted({ version: 1, type: 'auth_completed', requestId: 'login', runtime: 'claude' });
          assert.equal(supervisor.health.authTargets('claude').length, groups.length);
        }
        assert.equal(errors.length, 0, JSON.stringify(errors[0]));
      } finally {
        held.resolve({ status: 'uncertain' });
        await service?.stop();
        noticeFixtures.delete(root);
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
