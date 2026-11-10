import assert from 'node:assert/strict';
import { createDelivery } from '../../router/delivery.js';
import { fixture } from '../c4-v2-test-helpers.js';

// Real delivery policy and conditional ledger; terminal I/O alone is supplied.
// The outer runner must isolate HOME/ZYLOS_DIR/PM2_HOME/TMPDIR before import.
export function deliveryFixture(t) {
  const f = fixture(t), events = [], calls = [], verdicts = [];
  let time = 0, verdict = 'empty', run = 'run-1';
  const deps = {
    db: f.store, getSessionMode: () => 'multi', now: () => time,
    sleep: async ms => { time += ms; },
    openTmuxConnection: async () => {
      const connection = { closed: false, close: async () => { connection.closed = true; },
        command: async args => {
          assert.equal(connection.closed, false);
          if (args.at(-1) === '#{cursor_x}') { verdict = verdicts.shift() ?? 'empty'; return verdict === 'empty' ? '2' : '5'; }
          return '1';
        } };
      return connection;
    },
    resolveSessionTarget: async ({ sessionGroup, connection }) => {
      const target = { ready: true, runtime: 'claude', runId: run, sessionId: '$1', paneId: '%1', sessionGroup };
      connection.target = target; return target;
    },
    revalidateSessionTarget: async ({ target, connection }) => {
      assert.equal(connection.closed, false); assert.equal(connection.target, target);
    },
    getSessionAdapter: () => ({
      sendText: async args => { assert.equal(args.connection.closed, false); calls.push(['paste', args.target.sessionGroup]); },
      sendKeys: async args => { assert.equal(args.connection.closed, false); calls.push(['keys', args.target.sessionGroup, args.target.runId]); },
      captureScreen: async () => verdict === 'has_content' ? '──────────\n❯ text\n──────────'
        : verdict === 'disputed_empty' ? '──────────\n❯ \nsecond line draft\n──────────' : '──────────\n❯ \n──────────',
    }),
    readSessionState: async () => ({ identity: { runId: run, runtime: 'claude', ready: true },
      status: { valid: true, value: { state: 'idle', idle_seconds: 5, health: 'ok' } } }),
    readRuntimeHealth: () => ({ health: 'ok' }), readCurrentSession: async () => ({ runId: run, sessionId: 'session-1' }),
    formatConversation: row => row.content, notifyDelivered() {}, diagnostic: (event, fields) => events.push({ event, ...fields }),
  };
  const delivery = createDelivery(deps, { periodicEnabled: true, periodicIntervalMs: 5000, captureEnabled: false });
  t.after(() => delivery.stop());
  const message = (group = 'origin') => {
    const row = f.store.insertConversation('in', 'telegram', 'test', 'private message');
    assert.equal(f.store.claimConversation(row.id), true);
    return { ...row, session_group: group };
  };
  return { ...f, delivery, events, calls, verdicts, message, time: value => { time = value; }, run: value => { run = value; } };
}
