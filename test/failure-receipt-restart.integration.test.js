import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { systemSendEnvironment } from '../skills/comm-bridge/scripts/c4-system-send-env.js';
import { SupervisorServerHealth } from '../cli/lib/supervisor-server-health.js';
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

for (const phase of ['reserved', 'sent']) {
  // Run for owner-alert admission, cooldown, sender or settlement changes; skip UI-only
  // changes. HOME/ZYLOS_DIR/PM2_HOME and the actual DB are read back before spawn.
  // A private file-backed C4 DB and recorder subprocess replace the account edge;
  // no tmux/runtime/network is contacted. Every worker is killed/awaited on failure.
  test(`external failure owner alert survives restart after ${phase === 'reserved' ? 'cooldown admission before spawn' : 'send before queue settlement'}`, { timeout: 15000 }, async t => {
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
    assert.equal(captured(capture).length, phase === 'sent' ? 1 : 0);
    run.kill();
    const killed = await run.closed;
    assert.equal(killed.signal, 'SIGKILL');
    // A different failure in the same group/reason obeys the cooldown, while
    // the same admitted owner alert resumes after restart.
    const other = fail(endpoint, 'another private body');
    const resumed = launch(t, 'resume', path.join(dir, 'unused-marker'), capture);
    assert.equal((await resumed.closed).code, 0, resumed.stderr());
    const records = captured(capture);
    assert.equal(records.length, phase === 'sent' ? 2 : 1);
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

// Run for durable owner-alert retries and real C4 send failure behavior; skip
// UI-only changes. Read back private paths/DB before launching c4-send. The local
// owner and dashboard channel scripts always exit 1; no network or live tmux is
// used. Every child is awaited and timed out; fixture-owned files are removed.
test('permanently failing owner and Origin channels stop receiving alert attempts', { timeout: 20000 }, async t => {
  proveIsolation();
  const { createStore } = await import('../skills/comm-bridge/scripts/c4-v2-store.js');
  const { createFailureAlertSender } = await import('../skills/comm-bridge/scripts/failure-alert.js');
  const { createFailureReceiptDrainer } = await import('../skills/comm-bridge/scripts/c4-failure-receipts.js');
  const ownerChannel = 'owner-failing-test';
  for (const channel of [ownerChannel, 'dashboard']) {
    const scriptDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', channel, 'scripts');
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.writeFileSync(path.join(scriptDir, 'send.js'), 'process.exit(1);\n');
  }
  const endpoint = `permanent-channel-${++sequence}`, original = fail(endpoint, 'private original body');
  let clock = Math.floor(Date.now() / 1000);
  const createdAt = db.getDb().prepare('SELECT created_at FROM failure_receipts WHERE conversation_id=?').get(original.id).created_at;
  const store = createStore(db.getDb(), { now: () => clock * 1000 });
  const sends = [], events = [], children = new Set();
  t.after(async () => { await Promise.all([...children].map(child => new Promise(resolve => {
    child.once('close', resolve); child.kill('SIGKILL');
  }))); });
  const owner = new SupervisorServerHealth({
    readAlertTarget: () => ({ channel: ownerChannel, endpoint: 'owner-private' }),
    sendAlert: (target, message) => new Promise(resolve => {
      sends.push(target);
      const child = execFile(process.execPath,
        [fileURLToPath(new URL('../skills/comm-bridge/scripts/c4-send.js', import.meta.url)), target.channel, target.endpoint],
        { env: systemSendEnvironment(process.env, { notice: true }), timeout: 3000, maxBuffer: 8192 },
        error => { children.delete(child); resolve(!error); });
      children.add(child);
      child.stdin.on('error', () => {});
      child.stdin.end(message);
    }),
  });
  const sendFailureAlert = createFailureAlertSender({ db, notifyOwner: message => owner.notify(message), now: () => clock });
  const drain = createFailureReceiptDrainer({ db: store, now: () => clock, sendFailureAlert,
    diagnostic: (event, fields) => events.push({ event, fields }) });
  const attempts = channel => db.getDb().prepare("SELECT count(*) AS n FROM conversations WHERE direction='out' AND channel=? AND status='failed'").get(channel).n;
  for (let elapsed = 0; elapsed < 600; elapsed += 31) {
    clock = createdAt + elapsed;
    assert.equal((await drain()).pending, 1);
    assert.equal((await drain()).attempted, 0, 'immediate polling obeys persisted backoff');
  }
  assert.equal(attempts(ownerChannel), 20);
  assert.equal(attempts('dashboard'), 20);
  assert.equal(attempts(namespace), 0, 'the original external chat receives no failure receipt');
  assert.equal(sends.length, 40);
  clock = createdAt + 600;
  assert.equal((await drain()).settled, 1);
  clock += 3600;
  assert.equal((await drain()).attempted, 0);
  assert.equal(sends.length, 40);
  assert.equal(db.getDb().prepare('SELECT state FROM failure_receipts WHERE conversation_id=?').get(original.id).state, 'failed');
  assert.equal(events.filter(row => row.event === 'failure_receipt_send_failed').length, 20);
  assert.equal(events.filter(row => row.event === 'failure_receipt_exhausted').length, 1);
  assert.equal(JSON.stringify(events).includes('private original body'), false);
  t.diagnostic(JSON.stringify({ originalId: original.id, ownerFailedSends: attempts(ownerChannel),
    originFailedSends: attempts('dashboard'), originalChatSends: 0, terminal: 'failed', laterSends: 0 }));
});
