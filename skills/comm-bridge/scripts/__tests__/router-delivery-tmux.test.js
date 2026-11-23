import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDelivery } from '../router/delivery.js';
import { fixture } from './c4-v2-test-helpers.js';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { openTmuxConnection } from '../../../../cli/lib/runtime/tmux-connection.js';
import { resolveSessionTarget } from '../../../../cli/lib/runtime/session-target.js';
import { createSessionOps } from '../../../../cli/lib/runtime/session-ops.js';

// caller integration: real isolated tmux, real adapter
// ledger. The terminal is a recorder and is injected, not authenticated supervisor.
for (const mode of ['single', 'multi']) test(`real bound paste/Enter/cursor and ledger (${mode})`, async t => {
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
    session: createSessionOps(),
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
  const group = mode === 'single' ? 'origin' : row.session_group;
  assert.equal(calls[0].sessionGroup, group);
  assert.equal(saved.session_group, group);
});

test('actual bound target rejects run change after paste, never re-resolves during claim', async t => {
  const terminal = readyTmuxTarget(t, { runtime: 'codex', ledger: false });
  const f = fixture(t), row = f.store.insertConversation('in', 'telegram', 'e', 'message'); f.store.claimConversation(row.id);
  let resolutions = 0, sends = 0;
  const adapter = createSessionOps(), send = adapter.sendText;
  adapter.sendText = async args => { sends++; await send(args); terminal.tmux('set-environment', '-t', 'zylos-group-origin', 'ZYLOS_RUN_ID', 'replacement'); };
  const d = createDelivery({ db: f.store, getSessionMode: () => 'single', openTmuxConnection,
    resolveSessionTarget: options => { resolutions++; return resolveSessionTarget({ ...options, readReady: async () => terminal.ready }); },
    session: adapter,
    readSessionState: async () => ({ identity: { runId: terminal.ready.runId, runtime: 'codex', ready: true }, status: { valid: true, value: { state: 'idle', idle_seconds: 5, health: 'ok' } } }),
    readRuntimeHealth: () => ({ health: 'ok' }), readCurrentSession: async () => terminal.ready,
    formatConversation: row => row.content, notifyDelivered: () => {},
  }, { tmux: { socketPath: terminal.socketPath, binary: terminal.binary }, periodicEnabled: false, verifyWaitMs: 1 });
  await d.deliverConversation(row);
  const saved = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(row.id);
  assert.equal(saved.status, 'pending'); assert.equal(saved.retry_count, 0); assert.equal(resolutions, 1); assert.equal(sends, 1);
});
