import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';

const environment = createTestEnvironment();
const database = await import('../c4-db.js');
const { createDispatcher } = await import('../router/factory.js');
const { CONFIG_FILE, SKILLS_DIR } = await import('../../../../cli/lib/config.js');
const { tmuxNameForGroup } = await import('../../../../cli/lib/session-group-paths.js');
after(() => { database.close(); environment.cleanup(); });

// Real factory -> scheduler lane -> delivery -> private SQLite settlement.
// Run when periodic Enter composition, per-group budgets or lane callbacks change;
// unrelated UI changes may skip. The official runner isolates HOME/ZYLOS_DIR/
// PM2_HOME before imports; the outer harness isolates short TMPDIR and socket
// paths. Terminal I/O is supplied, with no tmux/model/PM2/network access. Stop
// drains delivery and clears its timer; the owned database/root close in after().
test('factory sends a due supplementary Enter to only the settled message group', async t => {
  const group = 'periodicfactorya', other = 'periodicfactoryb';
  const groups = ['origin', group, other];
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ runtime: 'codex', session_mode: 'multi' }));
  for (const channel of [group, other]) fs.mkdirSync(path.join(SKILLS_DIR, channel), { recursive: true });

  let clock = Date.now();
  const scenes = new Map(groups.map(sessionGroup => [sessionGroup, {
    present: true, ready: true, runtime: 'codex', runId: `run-${sessionGroup}`,
    sessionId: `business-${sessionGroup}`, runtimeSessionId: `business-${sessionGroup}`,
    tmuxName: tmuxNameForGroup(sessionGroup), serverGeneration: 'private-generation',
    paneId: `%${sessionGroup}`, createdAt: Math.floor(clock / 1000),
  }]));
  const row = database.insertConversation('in', group, 'private-endpoint', 'one message');
  const ledger = () => database.getDb().prepare('SELECT * FROM conversations WHERE id=?').get(row.id);
  assert.equal(ledger().session_group, group);
  const pastes = [], keys = [], periodicSends = [];
  const dispatcher = createDispatcher({
    env: { ...process.env, ZYLOS_SESSION_POOL_SIZE: '2' },
    db: database, now: () => clock,
    diagnostics: { diagnostic() {}, maintain() {} }, log() {},
    diagnostic: (event, fields) => { if (event === 'periodic_sent') periodicSends.push(fields); },
    listGroupTmuxSessions: async () => groups.map(sessionGroup => ({ sessionGroup, ...scenes.get(sessionGroup) })),
    readLiveIdentity: async sessionGroup => scenes.get(sessionGroup) ?? { present: false },
    readCurrentSession: async sessionGroup => ({ runId: `run-${sessionGroup}`, sessionId: `business-${sessionGroup}`, startupControlIds: [] }),
    readSessionState: async sessionGroup => ({ identity: scenes.get(sessionGroup),
      status: { valid: true, value: { state: 'idle', health: 'ok', idle_seconds: 4, proc: { alive: true } } } }),
    readRuntimeHealth: () => ({ missing: true }),
    openTmuxConnection: async () => ({ command: async args => args.at(-1) === '#{cursor_x}' ? '2' : '0', close: async () => {} }),
    resolveSessionTarget: async ({ sessionGroup }) => ({ ...scenes.get(sessionGroup), sessionGroup, sessionId: `$${sessionGroup}` }),
    revalidateSessionTarget: async () => {},
    getSessionAdapter: () => ({
      sendText: async ({ target, text }) => { pastes.push({ group: target.sessionGroup, text }); },
      sendKeys: async ({ target, keys: sent }) => { keys.push({ group: target.sessionGroup, keys: sent, status: ledger().status }); },
      captureScreen: async () => '❯ ',
      launch: async () => assert.fail('READY fixture must not launch'),
      stop: async () => assert.fail('READY fixture must not stop a runtime'),
    }),
    sleep: async () => {}, notifyDelivered() {},
    findLegacySessions: async () => [], advanceLegacy: async () => {}, prepareSingle: async () => {},
    submit: async () => assert.fail('READY fixture must not start a session'),
  }, { delivery: { periodicEnabled: true, periodicIntervalMs: 5000, periodicMaxAttempts: 3,
    verifyWaitMs: 1, captureEnabled: false } });
  t.after(() => dispatcher.stop());

  await dispatcher.initialize(); await dispatcher.idle();
  dispatcher.tick(); await dispatcher.idle();
  assert.equal(ledger().status, 'delivered');
  assert.equal(ledger().session_id, `business-${group}`);
  assert.equal(pastes.length, 1);
  assert.equal(pastes[0].group, group);
  assert.deepEqual(keys, [{ group, keys: ['Enter'], status: 'running' }]);

  clock += 4999;
  dispatcher.tick(); await dispatcher.idle();
  assert.equal(keys.length, 1, 'settled delivery keeps its original periodic deadline');
  clock += 1;
  dispatcher.tick(); await dispatcher.idle();
  assert.deepEqual(keys, [
    { group, keys: ['Enter'], status: 'running' },
    { group, keys: ['Enter'], status: 'delivered' },
  ]);
  assert.equal(periodicSends.length, 1);
  assert.equal(periodicSends[0].session_group, group);
  assert.equal(periodicSends[0].itemId, row.id);
  assert.equal(pastes.length, 1, 'post-settlement fallback must not paste again');
  assert.equal(ledger().retry_count, 0);
  assert.equal(ledger().session_id, `business-${group}`);
  assert.equal(keys.some(call => call.group === other || call.group === 'origin'), false);
});
