import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDelivery } from '../skills/comm-bridge/scripts/router/delivery.js';
import { fixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { readyTmuxTarget } from './helpers/ready-tmux-target.js';
import { createSessionReader } from '../cli/lib/session-state-reader-async.js';
import { observeSessionTarget, resolveSessionTarget } from '../cli/lib/runtime/session-target.js';
import { openTmuxConnection } from '../cli/lib/runtime/tmux-connection.js';
import { getSessionAdapter } from '../cli/lib/runtime/index.js';

// Covers stale file -> real reader -> router -> guarded tmux paste/Enter -> DB.
// Run for sample freshness/delivery gates; skip unrelated UI. Official runner
// isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR. The fixture owns a private socket,
// recorder process and DB; teardown stops delivery and kills its tmux server.
test('stale status delivers promptly to a ready isolated session and rejects unhealthy evidence', { timeout: 15000 }, async t => {
  const terminal = readyTmuxTarget(t, { runtime: 'codex', ledger: false });
  const f = fixture(t), log = path.join(terminal.root, 'lines');
  const script = path.join(terminal.root, 'terminal.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; import readline from 'node:readline';
    process.stdout.write('\\x1b[2J\\x1b[H\u276f ');
    readline.createInterface({input:process.stdin}).on('line',line=>{
      fs.appendFileSync(${JSON.stringify(log)},line+'\\n'); process.stdout.write('\\x1b[2J\\x1b[H\u276f ');
    });`);
  terminal.tmux('respawn-pane', '-k', '-t', 'zylos-group-origin', process.execPath, script);
  const tmux = { socketPath: terminal.socketPath, binary: terminal.binary };
  const readReady = async () => JSON.parse(fs.readFileSync(terminal.readyPath, 'utf8'));
  const reader = createSessionReader({ env: terminal.env, connectionOptions: tmux,
    observe: options => observeSessionTarget({ ...options, readReady }) });
  const statusPath = path.join(path.dirname(terminal.readyPath), 'agent-status.json');
  function writeStatus(health) {
    fs.writeFileSync(statusPath, JSON.stringify({ runId: terminal.ready.runId, sessionId: terminal.ready.sessionId,
      state: 'idle', idle_seconds: 60, health }));
    const old = new Date(Date.now() - 60000); fs.utimesSync(statusPath, old, old);
  }
  writeStatus('ok');
  const events = [];
  const delivery = createDelivery({ db: f.store, getSessionMode: () => 'single', openTmuxConnection,
    resolveSessionTarget: options => resolveSessionTarget({ ...options, readReady }), getSessionAdapter,
    readSessionState: reader.readSessionState, readRuntimeHealth: () => ({ health: 'ok' }),
    readCurrentSession: readReady, formatConversation: row => row.content, notifyDelivered: () => {},
    diagnostic: (event, fields) => events.push({ event, ...fields }),
  }, { tmux, periodicEnabled: false, verifyWaitMs: 25 });
  t.after(() => delivery.stop());
  t.diagnostic(JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: terminal.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, socket: terminal.socketPath, database: f.filename, statusPath }));
  for (let count = 0; count < 50 && !terminal.tmux('capture-pane', '-p', '-t', 'zylos-group-origin').includes('\u276f'); count++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const sample = await reader.readSessionState(null, { freshnessMs: 5000 });
  assert.equal(sample.status.reason, 'stale'); assert.equal(sample.status.value, null);
  assert.equal(sample.status.lastValue.health, 'ok');
  const row = f.store.insertConversation('in', 'telegram', 'e', 'stale sample delivery');
  f.store.claimConversation(row.id);
  const started = performance.now();
  await delivery.deliverConversation(row);
  const elapsedMs = performance.now() - started;
  assert.equal(f.db.prepare('SELECT status FROM conversations WHERE id=?').get(row.id).status, 'delivered');
  assert.ok(elapsedMs < 5000, `delivery took ${elapsedMs}ms`);
  assert.match(fs.readFileSync(log, 'utf8'), /stale sample delivery/);
  assert.ok(events.some(event => event.event === 'state_stale'));
  assert.equal(events.some(event => event.code === 'session_offline'), false);
  assert.ok(Date.now() - fs.statSync(statusPath).mtimeMs > 5000, 'no status writer refreshed the stale file');
  writeStatus('unavailable');
  const rejected = f.store.insertConversation('in', 'telegram', 'e', 'must remain pending');
  f.store.claimConversation(rejected.id); await delivery.deliverConversation(rejected);
  assert.equal(f.db.prepare('SELECT status FROM conversations WHERE id=?').get(rejected.id).status, 'pending');
  assert.ok(events.some(event => event.conversation_id === rejected.id && event.code === 'session_unhealthy'));
  assert.equal(fs.readFileSync(log, 'utf8').includes('must remain pending'), false);
  t.diagnostic(JSON.stringify({ elapsedMs, sampleAgeMs: Date.now() - sample.status.sampledAt, unhealthyRejected: true }));
});
