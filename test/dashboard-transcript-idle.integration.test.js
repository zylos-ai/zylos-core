import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../skills/dashboard/src/lib/store.js';
import { UsageTranscripts } from '../skills/dashboard/src/lib/collectors/usage-transcripts.js';
import { ConversationCollector } from '../skills/dashboard/src/lib/collectors/conversation-collector.js';
import { claudeProjectSlug } from '../skills/dashboard/src/lib/claude-project-path.js';

const home = fs.realpathSync(process.env.HOME);
assert.notEqual(home, fs.realpathSync(os.userInfo().homedir));
const isolated = path.dirname(home);
for (const name of ['ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
  assert.ok(process.env[name]?.startsWith(isolated + path.sep), `${name} must be isolated`);
}
assert.ok(Buffer.byteLength(path.join(process.env.TMPDIR, 'test.sock')) < 104);
console.log('Idle transcript isolation:', JSON.stringify({ HOME: home,
  ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: process.env.PM2_HOME,
  TMPDIR: process.env.TMPDIR, database: 'temporary fixture only',
  tmux: 'unused', network: 'none', children: 'none' }));

const MINUTE = 60000;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-'));
  const store = new Store(path.join(root, 'dashboard.db'));
  let at = Date.now();
  const snapshot = { listKnown: true, rows: [] };
  const inventory = new UsageTranscripts(store, { homeDir: root, zylosDir: root }, {
    now: () => at, getSnapshot: async () => snapshot, getSnapshotKey: () => 'stable',
  });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const add = (name, { age = 0, offset = 0, parent, runtime = 'claude' } = {}) => {
    const file = path.join(root, `${name}.jsonl`);
    fs.writeFileSync(file, 'line\n');
    fs.utimesSync(file, new Date(at - age), new Date(at - age));
    store.insertUsageTranscript({ transcript_path: file, runtime, session_id: 'legacy',
      byte_offset: offset, parent_path: parent }, new Date(at).toISOString());
    return file;
  };
  const statusline = age => {
    const dir = path.join(root, 'activity-monitor');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'statusline.json');
    fs.writeFileSync(file, JSON.stringify({ session_id: 'legacy' }));
    fs.utimesSync(file, new Date(at - age), new Date(at - age));
  };
  return { root, store, inventory, snapshot, add, statusline,
    at: () => at, advance: ms => { at += ms; } };
}

// Real Store/collector/files: run for cursor scheduling or commit changes; skip
// unrelated UI changes. Runner isolation is checked above; no services or tmux.
test('unchanged transcript inventory rounds write no rows and start no cursor transactions', async t => {
  const f = fixture(t);
  for (let i = 0; i < 60; i++) f.add(String(i).padStart(2, '0'), { offset: 5 });
  f.inventory.discover();
  const transaction = f.store.db.transaction.bind(f.store.db);
  let transactions = 0;
  f.store.db.transaction = callback => { transactions++; return transaction(callback); };
  const before = f.store.db.prepare('SELECT total_changes() AS n').get().n;
  const seen = new Set();
  for (let i = 0; i < 2; i++) {
    await f.inventory.collect('claude', row => { seen.add(row.transcript_path); return row.byte_offset; });
    f.advance(5000);
  }
  assert.equal(seen.size, 60);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, before);
  assert.equal(transactions, 0);
});

// Real collector callback and SQLite change counter. Run for inventory/Claude
// cursor changes; skip UI changes. Same runner isolation, no services or children.
test('an idle real Claude collector leaves the progress table unchanged', async t => {
  const f = fixture(t);
  const file = f.add('main', { offset: 5 });
  f.inventory.discover();
  const collector = new ConversationCollector(f.store, { homeDir: f.root, zylosDir: f.root },
    { transcripts: f.inventory });
  const before = f.store.getUsageTranscript(file);
  const changes = f.store.db.prepare('SELECT total_changes() AS n').get().n;
  await collector.collect();
  assert.deepEqual(f.store.getUsageTranscript(file), before);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, changes);
});

// Mixed-runtime shared selection: run for batching changes, skip UI changes.
// No collectors/services are started; real inventory commits use a temporary DB.
test('Claude and Codex progress in a shared round uses one cursor transaction', async t => {
  const f = fixture(t);
  const claude = f.add('claude'), codex = f.add('codex', { runtime: 'codex' });
  f.inventory.discover();
  const transaction = f.store.db.transaction.bind(f.store.db);
  let transactions = 0;
  f.store.db.transaction = callback => { transactions++; return transaction(callback); };
  await f.inventory.collect('claude', () => 5);
  await f.inventory.collect('codex', () => 5);
  assert.equal(transactions, 1);
  for (const file of [claude, codex]) assert.equal(f.store.getUsageTranscript(file).byte_offset, 5);
});

// Missing poller fallback: run for shared-round scheduling changes; skip UI.
// Isolated files/DB only; no timers, services or child processes.
test('a new round commits completed cursors when the other runtime did not poll', async t => {
  const f = fixture(t);
  const claude = f.add('claude'); f.add('codex', { runtime: 'codex' });
  f.inventory.discover();
  await f.inventory.collect('claude', () => 5);
  f.advance(5000);
  await f.inventory.collect('claude', row => row.byte_offset);
  assert.equal(f.store.getUsageTranscript(claude).byte_offset, 5);
});

// Real transaction boundaries and row persistence. Run for cursor batching/error
// changes; skip unrelated UI changes. Temporary DB/files only; cleanup via t.after.
test('changed transcript cursors commit in one transaction, including progress before an error', async t => {
  const f = fixture(t);
  const files = [f.add('a'), f.add('b'), f.add('c')];
  f.inventory.discover();
  const transaction = f.store.db.transaction.bind(f.store.db);
  let transactions = 0;
  f.store.db.transaction = callback => { transactions++; return transaction(callback); };
  await assert.rejects(f.inventory.collect('claude', row => {
    if (row.transcript_path === files[2]) throw new Error('read failed');
    return 5;
  }), /read failed/);
  assert.equal(transactions, 1);
  assert.equal(f.store.getUsageTranscript(files[0]).byte_offset, 5);
  assert.equal(f.store.getUsageTranscript(files[1]).byte_offset, 5);
  assert.equal(f.store.getUsageTranscript(files[2]).byte_offset, 0);
});

// Real statusline and retention path. Run for legacy liveness/expiry changes;
// skip unrelated UI changes. No live resources, services, children or sockets.
test('stale legacy statusline releases EOF main and child records for retention', async t => {
  const f = fixture(t);
  const main = f.add('main', { age: 31 * MINUTE, offset: 5 });
  const child = f.add('child', { age: 31 * MINUTE, offset: 5, parent: main });
  f.statusline(31 * MINUTE);
  await f.inventory.collect('claude', row => row.byte_offset);
  for (const file of [main, child]) assert.equal(f.store.getUsageTranscript(file).status, 'finished');
  f.advance(9 * 86400000);
  f.inventory.discover();
  for (const file of [main, child]) assert.equal(f.store.getUsageTranscript(file), null);
});

// Reject boundaries for inactivity: current legacy signal, recent content,
// incomplete read and unavailable snapshot. Same isolated files/DB; no services.
test('fresh legacy liveness, recent files, unread bytes and unknown snapshots prevent expiry', async t => {
  for (const mode of ['fresh-status', 'recent-file', 'unread', 'unknown-snapshot']) {
    const f = fixture(t);
    const file = f.add('main', { age: mode === 'recent-file' ? MINUTE : 31 * MINUTE,
      offset: mode === 'unread' ? 0 : 5 });
    f.statusline(mode === 'fresh-status' ? MINUTE : 31 * MINUTE);
    if (mode === 'unknown-snapshot') f.snapshot.listKnown = false;
    await f.inventory.collect('claude', row => row.byte_offset);
    assert.equal(f.store.getUsageTranscript(file).status, 'active', mode);
  }
});

// Error flush with another runtime still outstanding: run for shared-round
// error/commit changes; skip UI work. Isolated files/DB only, no background work.
test('a runtime failure commits its completed progress before the other runtime polls', async t => {
  const f = fixture(t);
  const completed = f.add('a', { age: 31 * MINUTE });
  const failed = f.add('b');
  const codex = f.add('codex', { runtime: 'codex' });
  f.statusline(31 * MINUTE);
  await assert.rejects(f.inventory.collect('claude', row => {
    if (row.transcript_path === failed) throw new Error('read failed');
    return 5;
  }), /read failed/);
  const row = f.store.getUsageTranscript(completed);
  assert.equal(row.byte_offset, 5);
  assert.equal(row.status, 'finished');
  assert.equal(f.store.getUsageTranscript(failed).byte_offset, 0);
  assert.equal(f.store.getUsageTranscript(codex).byte_offset, 0);
});

// Real collector output distinguishes fresh/stale legacy attribution even with
// new content. Run for Origin liveness changes; skip UI. Private files/DB only.
test('fresh content in a stale legacy transcript is not emitted as an Origin message', async t => {
  for (const age of [MINUTE, 31 * MINUTE]) {
    const f = fixture(t);
    const file = f.add('main');
    fs.writeFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'legacy-message',
      timestamp: new Date(f.at()).toISOString(), sessionId: 'legacy',
      message: { content: [{ type: 'text', text: 'New assistant content' }] } }) + '\n');
    f.statusline(age);
    const collector = new ConversationCollector(f.store, { homeDir: f.root, zylosDir: f.root },
      { transcripts: f.inventory });
    let emitted = 0;
    collector._onEvent = () => { emitted++; };
    await collector.collect();
    assert.equal(f.store.getUsageTranscript(file).byte_offset, fs.statSync(file).size);
    const expected = age === MINUTE ? 1 : 0;
    assert.equal(emitted, expected);
    assert.equal(f.store.queryEvents({ eventType: 'assistant_message' }).length, expected);
  }
});

// Discovery must reject a stale pointer to a real, unregistered file. Run for
// legacy discovery changes; skip UI. No services/sockets/children are used.
test('only a fresh legacy statusline discovers an unregistered transcript', t => {
  const f = fixture(t);
  const file = path.join(f.root, '.claude', 'projects', claudeProjectSlug(f.root), 'legacy.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'line\n');
  f.statusline(31 * MINUTE);
  f.inventory.discover();
  assert.equal(f.store.getUsageTranscript(file), null);
  f.statusline(MINUTE);
  f.inventory.discover();
  assert.equal(f.store.getUsageTranscript(file).status, 'active');
});

// Competing persisted cursor versus delayed mixed-runtime flush. Run for cursor
// guards/batching changes; skip UI. Temporary Store/files; cleanup via t.after.
test('a delayed round preserves a cursor changed by another writer', async t => {
  const f = fixture(t);
  const claude = f.add('claude');
  f.add('codex', { runtime: 'codex' });
  await f.inventory.collect('claude', () => 5);
  assert.equal(f.store.getUsageTranscript(claude).byte_offset, 0);
  f.store.updateUsageTranscript(claude, { byte_offset: 3, status: 'active',
    now: new Date(f.at()).toISOString() });
  await f.inventory.collect('codex', () => 5);
  const current = f.store.getUsageTranscript(claude);
  assert.equal(current.status, 'active');
  assert.equal(current.byte_offset, 3);
});
