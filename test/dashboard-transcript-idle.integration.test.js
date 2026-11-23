import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../skills/dashboard/src/lib/store.js';
import { UsageTranscripts } from '../skills/dashboard/src/lib/collectors/usage-transcripts.js';
import { ConversationCollector } from '../skills/dashboard/src/lib/runtime/claude/collector.js';
import { getDashboardRuntime as getCollectorRuntime } from '../skills/dashboard/src/lib/runtime/index.js';

const collectors = Object.fromEntries(await Promise.all(['claude', 'codex'].map(async id =>
  [id, (await getCollectorRuntime(id)).collector])));

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
  const inventory = new UsageTranscripts(store, { homeDir: root, zylosDir: root }, { collectors,
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
