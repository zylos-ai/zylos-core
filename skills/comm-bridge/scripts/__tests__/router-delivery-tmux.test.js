import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDelivery } from '../router/delivery.js';
import { fixture } from './c4-v2-test-helpers.js';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { openTmuxConnection } from '../../../../cli/lib/runtime/tmux-connection.js';
import { resolveSessionTarget } from '../../../../cli/lib/runtime/session-target.js';
import { getSessionAdapter } from '../../../../cli/lib/runtime/index.js';

// T04 / IB-12 caller integration: real isolated tmux, real adapter, real P01
// ledger. The terminal is a recorder and F4 is injected, not authenticated M3/M4.
for (const mode of ['single', 'multi']) test(`real P02 bound paste/Enter/cursor and ledger (${mode})`, async t => {
  const terminal = readyTmuxTarget(t, { mode, runtime: 'codex', ledger: false });
  const f = fixture(t); const log = path.join(terminal.root, 'lines');
  const script = path.join(terminal.root, 'terminal.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; import readline from 'node:readline';
    process.stdout.write('\\x1b[2J\\x1b[H❯ ');
    readline.createInterface({input:process.stdin}).on('line',line=>{
      fs.appendFileSync(${JSON.stringify(log)},line+'\\n'); process.stdout.write('\\x1b[2J\\x1b[H❯ ');
    });`);
  terminal.tmux('respawn-pane', '-k', '-t', 'zylos-group-origin', process.execPath, script);
  const row = f.store.insertConversation('in', 'telegram', 'e', "literal '; run-shell nope\nsecond");
  f.store.claimConversation(row.id);
  const calls = [], tmux = { socketPath: terminal.socketPath, binary: terminal.binary };
  const deps = {
    db: f.store, getSessionMode: () => mode,
    openTmuxConnection,
    resolveSessionTarget: options => resolveSessionTarget({ ...options, sessionGroup: 'origin', readReady: async () => terminal.ready }),
    getSessionAdapter,
    readSessionState: async () => ({ identity: { runId: terminal.ready.runId, runtime: 'codex', ready: true }, status: { valid: true, value: { state: 'idle', idle_seconds: 5, health: 'ok' } } }),
    readRuntimeHealth: () => ({ health: 'ok' }), readCurrentSession: async () => terminal.ready,
    formatConversation: row => row.content, notifyDelivered: data => calls.push(data),
  };
  // Wait for the harmless terminal to own stdin before the actual paste.
  for (let count = 0; count < 50 && !terminal.tmux('capture-pane', '-p', '-t', 'zylos-group-origin').includes('❯'); count++) await new Promise(r => setTimeout(r, 10));
  const d = createDelivery(deps, { tmux, periodicEnabled: false, verifyWaitMs: 25 });
  await d.deliverConversation(row);
  const saved = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(row.id);
  assert.equal(saved.status, 'delivered'); assert.equal(saved.session_id, terminal.ready.sessionId);
  assert.match(fs.readFileSync(log, 'utf8'), /literal '; run-shell nope\nsecond/);
  assert.equal(calls.length, 1); assert.equal(calls[0].runId, terminal.ready.runId);
  assert.equal(calls[0].sessionGroup, mode === 'single' ? null : row.session_group);
});

test('actual bound target rejects run change after paste, never re-resolves during claim', async t => {
  const terminal = readyTmuxTarget(t, { runtime: 'codex', ledger: false });
  const f = fixture(t), row = f.store.insertConversation('in', 'telegram', 'e', 'message'); f.store.claimConversation(row.id);
  let resolutions = 0, sends = 0;
  const adapter = getSessionAdapter('codex'), send = adapter.sendText.bind(adapter);
  adapter.sendText = async args => { sends++; await send(args); terminal.tmux('set-environment', '-t', 'zylos-group-origin', 'ZYLOS_RUN_ID', 'replacement'); };
  const d = createDelivery({ db: f.store, getSessionMode: () => 'single', openTmuxConnection,
    resolveSessionTarget: options => { resolutions++; return resolveSessionTarget({ ...options, readReady: async () => terminal.ready }); },
    getSessionAdapter: () => adapter,
    readSessionState: async () => ({ identity: { runId: terminal.ready.runId, runtime: 'codex', ready: true }, status: { valid: true, value: { state: 'idle', idle_seconds: 5, health: 'ok' } } }),
    readRuntimeHealth: () => ({ health: 'ok' }), readCurrentSession: async () => terminal.ready,
    formatConversation: row => row.content, notifyDelivered: () => {},
  }, { tmux: { socketPath: terminal.socketPath, binary: terminal.binary }, periodicEnabled: false, verifyWaitMs: 1 });
  await d.deliverConversation(row);
  const saved = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(row.id);
  assert.equal(saved.status, 'pending'); assert.equal(saved.retry_count, 0); assert.equal(resolutions, 1); assert.equal(sends, 1);
});

for (const replacement of ['server', 'pane']) for (const type of ['conversation', 'directed', 'ordinary']) {
  test(`real ${replacement} replacement rejects ${type} without sending to new target`, async t => {
    const terminal = readyTmuxTarget(t, { runtime: 'codex', ledger: false });
    const f = fixture(t); const tmux = { socketPath: terminal.socketPath, binary: terminal.binary };
    const connection = await openTmuxConnection(tmux);
    const initial = await resolveSessionTarget({ sessionGroup: null, connection, readReady: async () => terminal.ready });
    connection.close();
    const binding = { expectedRunId: initial.runId, tmuxTarget: { serverGeneration: initial.serverGeneration, sessionId: initial.sessionId, paneId: initial.paneId } };
    const row = type === 'conversation' ? f.store.insertConversation('in', 'telegram', 'e', 'NEVER_NEW_TARGET') :
      f.store.insertControl('NEVER_NEW_TARGET', { sessionGroup: 'origin', appendAckSuffix: false, targetBinding: type === 'directed' ? binding : null });
    (type === 'conversation' ? f.store.claimConversation : f.store.claimControl)(row.id);
    const adapter = getSessionAdapter('codex'), original = adapter.sendText.bind(adapter);
    let resolutions = 0;
    adapter.sendText = async args => {
      if (replacement === 'server') terminal.tmux('kill-server');
      else { terminal.tmux('new-session', '-d', '-s', 'keeper', '/bin/sleep', '120'); terminal.tmux('kill-session', '-t', 'zylos-group-origin'); }
      terminal.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'zylos-group-origin', '-e', `ZYLOS_RUN_ID=${initial.runId}`,
        '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"codex","mode":"default"}', '/bin/sleep', '120');
      await original(args);
    };
    const db = { ...f.store, requeueControl: id => f.db.prepare("UPDATE control_queue SET status='pending' WHERE id=? AND status='running'").run(id),
      retryOrFailControl: () => assert.fail('identity mismatch must not count a delivery retry'), ackControl: () => assert.fail('replacement cannot be acked') };
    const d = createDelivery({ db, getSessionMode: () => 'single', openTmuxConnection,
      resolveSessionTarget: options => { resolutions++; return resolveSessionTarget({ ...options, readReady: async () => terminal.ready }); },
      getSessionAdapter: () => adapter,
      readSessionState: async () => ({ identity: { runId: initial.runId, runtime: 'codex', ready: true }, status: { valid: true, value: { state: 'idle', health: 'ok' } } }),
      readRuntimeHealth: () => ({ health: 'ok' }), readCurrentSession: async () => terminal.ready,
      formatConversation: row => row.content, notifyDelivered: () => assert.fail('replacement must not be notified'),
    }, { tmux, periodicEnabled: false });
    await (type === 'conversation' ? d.deliverConversation(row) : d.deliverControl(row));
    const saved = f.db.prepare(`SELECT * FROM ${type === 'conversation' ? 'conversations' : 'control_queue'} WHERE id=?`).get(row.id);
    assert.equal(saved.status, type === 'directed' ? 'timeout' : 'pending'); assert.equal(saved.retry_count, 0);
    if (type === 'directed') assert.equal(saved.last_error, 'STALE_TARGET');
    assert.equal(resolutions, 1);
    assert(!terminal.tmux('capture-pane', '-p', '-t', 'zylos-group-origin').includes('NEVER_NEW_TARGET'));
  });
}

test('two same-run /clear F3 replacements use current business session ids in real ledger', async t => {
  const terminal = readyTmuxTarget(t, { runtime: 'codex', ledger: false });
  const f = fixture(t); let current = { ...terminal.ready }, sends = 0;
  const adapter = getSessionAdapter('codex');
  // Actual guarded paste; cursor verdict is injected because the sleeping test
  // target is not a runtime UI. F3 changes between paste and the ledger read.
  const original = adapter.sendText.bind(adapter);
  adapter.sendText = async args => { await original(args); current = { ...current, sessionId: `cleared-${++sends}` }; fs.writeFileSync(terminal.readyPath, JSON.stringify(current)); };
  adapter.captureScreen = async () => '❯ ';
  const d = createDelivery({ db: f.store, getSessionMode: () => 'single',
    openTmuxConnection: async options => {
      const connection = await openTmuxConnection(options), command = connection.command.bind(connection);
      connection.command = (args, options) => args.at(-1) === '#{cursor_x}' ? Promise.resolve('2') : args.at(-1) === '#{cursor_y}' ? Promise.resolve('0') : command(args, options);
      return connection;
    },
    resolveSessionTarget: options => resolveSessionTarget({ ...options, readReady: async () => JSON.parse(fs.readFileSync(terminal.readyPath, 'utf8')) }),
    getSessionAdapter: () => adapter,
    readSessionState: async () => ({ identity: { runId: current.runId, runtime: 'codex', ready: true }, status: { valid: true, value: { state: 'idle', health: 'ok' } } }),
    readRuntimeHealth: () => ({ health: 'ok' }), readCurrentSession: async () => JSON.parse(fs.readFileSync(terminal.readyPath, 'utf8')),
    formatConversation: row => row.content, notifyDelivered: () => {},
  }, { tmux: { socketPath: terminal.socketPath, binary: terminal.binary }, periodicEnabled: false, verifyWaitMs: 1 });
  for (const sessionId of ['cleared-1', 'cleared-2']) {
    const row = f.store.insertConversation('in', 'telegram', 'e', 'clear-window'); f.store.claimConversation(row.id);
    await d.deliverConversation(row);
    const saved = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(row.id);
    assert.equal(saved.status, 'delivered'); assert.equal(saved.session_id, sessionId);
  }
});
