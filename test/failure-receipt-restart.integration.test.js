import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestEnvironment } from '../scripts/test-environment.js';

const environment = createTestEnvironment();
const db = await import('../skills/comm-bridge/scripts/c4-db.js');
after(() => { db.close(); environment.cleanup(); });
const worker = fileURLToPath(new URL('./helpers/failure-receipt-restart-worker.js', import.meta.url));
const namespace = 'receipt-test';
fs.mkdirSync(path.join(process.env.ZYLOS_DIR, '.claude', 'skills', namespace), { recursive: true });
let sequence = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function within(parent, filename) {
  const relative = path.relative(parent, filename);
  return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function proveIsolation() {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME']) assert.ok(within(environment.root, process.env[key]), `${key} must be private`);
  assert.ok(process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR), 'runner must set TMPDIR');
  assert.ok(within(process.env.TMPDIR, environment.root) || within(environment.root, process.env.TMPDIR),
    'TMPDIR must belong to the temporary test hierarchy');
  const databasePath = db.getDb().pragma('database_list').find(row => row.name === 'main').file;
  assert.ok(within(process.env.ZYLOS_DIR, databasePath), 'actual SQLite path must belong to the private instance');
  return databasePath;
}
function launch(t, phase, marker, capture) {
  const child = spawn(process.execPath, [worker, phase, marker], {
    env: { ...process.env, TZ: 'Asia/Singapore', FAILURE_RECEIPT_CAPTURE: capture },
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  let stderr = '', exited = false;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  child.stdout.resume();
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  const kill = () => {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  };
  t.after(async () => { kill(); await closed; });
  return { child, closed, kill, exited: () => exited, stderr: () => stderr };
}
async function waitForBarrier(run, marker) {
  const until = performance.now() + 5000;
  while (!fs.existsSync(marker)) {
    assert.equal(run.exited(), false, run.stderr());
    assert.ok(performance.now() < until, 'worker did not reach its crash barrier');
    await delay(10);
  }
  return JSON.parse(fs.readFileSync(marker, 'utf8'));
}
function captured(filename) {
  if (!fs.existsSync(filename)) return [];
  const text = fs.readFileSync(filename, 'utf8');
  assert.ok(Buffer.byteLength(text) <= 8192, 'capture must remain bounded');
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function fail(endpoint, body) {
  const row = db.insertConversation('in', namespace, endpoint, body, { groupName: endpoint });
  assert.equal(db.claimConversation(row.id), true);
  assert.equal(db.failDelivery(row.id, { maxRetries: 1, reason: 'launch_failed' }).status, 'failed');
  return row;
}

for (const phase of ['reserved']) {
  // Run for owner-alert admission, cooldown, sender or settlement changes; skip UI-only
  // changes. HOME/ZYLOS_DIR/PM2_HOME and the actual DB are read back before spawn.
  // A private file-backed C4 DB and recorder subprocess replace the account edge;
  // no tmux/runtime/network is contacted. Every worker is killed/awaited on failure.
  test(`external failure owner alert survives restart after cooldown admission before spawn`, { timeout: 15000 }, async t => {
    const databasePath = proveIsolation();
    const dir = fs.mkdtempSync(path.join(environment.root, 'receipt-crash-'));
    const marker = path.join(dir, 'barrier.json'), capture = path.join(dir, 'capture.ndjson');
    const endpoint = `private-chat-${++sequence}`;
    const original = fail(endpoint, 'private original body');
    const run = launch(t, phase, marker, capture);
    assert.equal((await waitForBarrier(run, marker)).phase, phase);
    const durable = db.getDb().prepare('SELECT state FROM failure_receipts WHERE conversation_id=?').get(original.id);
    assert.equal(durable.state, 'queued');
    assert.equal(db.getStatusNoticeCooldowns().filter(row => row.cooldown_key.includes(original.session_group)).length, 1);
    assert.equal(captured(capture).length, 0);
    run.kill();
    const killed = await run.closed;
    assert.equal(killed.signal, 'SIGKILL');
    // A different failure in the same group/reason obeys the cooldown, while
    // the same admitted owner alert resumes after restart.
    const other = fail(endpoint, 'another private body');
    const resumed = launch(t, 'resume', path.join(dir, 'unused-marker'), capture);
    assert.equal((await resumed.closed).code, 0, resumed.stderr());
    const records = captured(capture);
    assert.equal(records.length, 1);
    assert.ok(records.every(row => row.argv[0] === 'owner-test' && row.argv[1] === 'owner-private'));
    assert.ok(records.every(row => row.body.includes(`#${original.id}`) && row.body.includes(endpoint) && row.body.includes(original.session_group)));
    assert.ok(records.every(row => !row.body.includes('private original body') && !row.body.includes('another private body')));
    assert.equal(db.getDb().prepare('SELECT state FROM failure_receipts WHERE conversation_id=?').get(original.id).state, 'sent');
    assert.equal(db.getDb().prepare('SELECT state FROM failure_receipts WHERE conversation_id=?').get(other.id).state, 'suppressed');
    assert.equal(db.listFailureReceipts().length, 0);
    t.diagnostic(JSON.stringify({ phase, databasePath, originalId: original.id, confirmedSends: records.length,
      otherAlert: 'suppressed', killedSignal: killed.signal }));
  });
}
