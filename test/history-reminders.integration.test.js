import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shellQuote } from '../skills/comm-bridge/scripts/c4-query-format.js';

const home = fs.realpathSync(process.env.HOME);
assert.notEqual(home, fs.realpathSync(os.userInfo().homedir));
// Give this worker its own database before any C4 module captures ZYLOS_DIR.
const runnerZylosDir = process.env.ZYLOS_DIR;
const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'history-readers-'));
process.env.ZYLOS_DIR = privateRoot;
let closeDatabase;
after(() => {
  try { closeDatabase?.(); }
  finally {
    if (runnerZylosDir === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = runnerZylosDir;
    fs.rmSync(privateRoot, { recursive: true, force: true });
    assert.equal(fs.existsSync(privateRoot), false);
  }
});
const { databaseCli, fetchCli } = await import('../skills/comm-bridge/scripts/c4-public-cli.js');
const { getDb, close } = await import('../skills/comm-bridge/scripts/c4-db.js');
closeDatabase = close;
const { DB_PATH, SKILLS_DIR } = await import('../skills/comm-bridge/scripts/c4-config.js');
assert.notEqual(path.resolve(process.env.ZYLOS_DIR), path.resolve(runnerZylosDir));
assert.ok(DB_PATH.startsWith(process.env.ZYLOS_DIR + path.sep));
for (const key of ['ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
  assert.ok(path.resolve(process.env[key]).startsWith(path.dirname(home) + path.sep));
}
console.log('History reader isolation:', JSON.stringify({ HOME: home, ZYLOS_DIR: process.env.ZYLOS_DIR,
  PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, database: DB_PATH, runtime: 'not launched' }));

function caller(value) {
  if (value === undefined) delete process.env.ZYLOS_SESSION_GROUP;
  else process.env.ZYLOS_SESSION_GROUP = value;
}
function seed(t, groups = ['chat:mine', 'chat:peer', 'chat:peer', 'chat:other', 'origin']) {
  const previous = process.env.ZYLOS_SESSION_GROUP;
  t.after(() => { caller(previous); close(); });
  const db = getDb();
  db.exec('DELETE FROM conversations; DELETE FROM checkpoints; DELETE FROM group_heads; DELETE FROM origin_sync_cursors;');
  const insert = db.prepare(`INSERT INTO conversations(id,timestamp,direction,channel,content,status,session_group)
    VALUES(?,'2026-01-01 00:00:00','out','system',?,'delivered',?)`);
  groups.forEach((group, i) => insert.run(i + 1, `message ${i + 1}`, group));
  db.exec('INSERT INTO group_heads(session_group,head_id) SELECT session_group,MAX(id) FROM conversations GROUP BY session_group;');
  return db;
}
const readers = [
  ['range', args => fetchCli(['--begin', '1', '--end', '5', ...args])],
  ['since', args => fetchCli(['--since', '2026-01-01', ...args])],
];
const expectedNotes = () => ['chat:peer', 'chat:other', 'origin'].map((group, i) =>
  `Note: ${i === 0 ? '2 rows above belong' : '1 row above belongs'} to session group ${group}; ${i === 0 ? 'they are' : 'it is'} history. For its current state, ask that thread:\ncat <<'EOF_INTERNAL' | node ${shellQuote(path.join(SKILLS_DIR, 'comm-bridge/scripts/c4-send.js'))} internal ${shellQuote(group)}\n<Fill in your question about the current state.>\nEOF_INTERNAL\n`
).join('');

// Real public parsers and private SQLite reads; no transport/services/socket.
// Run for history text formatting changes; skip unrelated delivery/UI changes.
for (const [name, read] of readers) test(`History ${name} appends one counted reminder per foreign group without changing rows`, t => {
  const db = seed(t);
  caller(undefined);
  const before = read([]);
  const changes = db.prepare('SELECT total_changes() AS n').get().n;
  caller('chat:mine');
  assert.equal(read([]), before + expectedNotes());
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
});

test('History reads of only the caller group and empty results keep their original text', t => {
  seed(t, ['chat:mine']);
  caller(undefined);
  const before = readers.map(([, read]) => read([]));
  caller('chat:mine');
  readers.forEach(([, read], i) => assert.equal(read([]), before[i]));
  assert.equal(fetchCli(['--begin', '20', '--end', '30']), '[Conversations] (id 20 ~ 30)\nNo conversations in this range.\n');
});

test('History single origin Sync and JSON reads preserve the baseline bytes', t => {
  seed(t);
  const protocolReaders = [...readers, ['recent', args => databaseCli(['recent', '5', ...args])]];
  let outputs = 0;
  caller(undefined);
  const plain = protocolReaders.map(([, read]) => read([]));
  for (const group of [undefined, '', 'origin']) {
    caller(group);
    protocolReaders.forEach(([name, read], i) => {
      const text = read([]);
      assert.equal(text, plain[i], `${name}: caller=${JSON.stringify(group)}`);
      assert.equal(text.includes('Note:'), false, `${name}: excluded caller reminder`);
      outputs++;
    });
  }
  for (const [name, read] of protocolReaders) {
    caller(undefined); const before = read(['--json']);
    caller('chat:mine'); const after = read(['--json']);
    assert.equal(after, before, `${name}: JSON bytes`);
    assert.equal(JSON.parse(after).ok, true, `${name}: JSON envelope`);
    assert.equal(after.includes('Note:'), false, `${name}: JSON reminder`);
    outputs++;
  }
  const syncReaders = [
    ['unsummarized', () => fetchCli(['--unsummarized'])],
    ['scoped unsummarized', () => fetchCli(['--unsummarized', '--group', 'chat:peer'])],
    ['origin combined', () => fetchCli(['--origin-sync', '--group', 'chat:peer'])],
    ['origin summaries', () => fetchCli(['--origin-sync', '--group', 'chat:peer', '--summaries-only'])],
    ['origin raw', () => fetchCli(['--origin-sync', '--group', 'chat:peer', '--raw-only', '--after', '0'])],
    ['database unsummarized', () => databaseCli(['unsummarized'])],
    ['origin backlog', () => databaseCli(['origin-sync', 'backlog'])],
    ['fetch checkpoints', () => fetchCli(['--checkpoints', '--after', '0'])],
    ['database checkpoints', () => databaseCli(['checkpoints'])],
  ];
  for (const [name, read] of syncReaders) {
    caller(undefined); const before = read();
    caller('chat:mine'); const after = read();
    assert.equal(after, before, `${name}: caller-independent bytes`);
    assert.equal(after.includes('Note:'), false, `${name}: no reminder`);
    if (name === 'origin raw') {
      assert.equal(after, '[2026-01-01 00:00:00] OUT (system):\nmessage 2\n\n[2026-01-01 00:00:00] OUT (system):\nmessage 3\n\n', 'origin raw: two foreign rows must be read');
    }
    outputs++;
  }
  assert.equal(outputs, 21);
  console.log('History compatibility:', JSON.stringify({ outputs, originRawRows: 2 }));
});

// Actual CLI entrypoint child reads only this worker's private DB. Timeout and
// maxBuffer bound the child; spawnSync reaps it. No background loops or runtime.
// Run for public CLI entry/output changes; skip template-only changes.
test('History CLI prints the foreign-group reminder after the original text', t => {
  seed(t);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../skills/comm-bridge/scripts/c4-fetch.js', import.meta.url)),
    '--begin', '1', '--end', '5'], { cwd: process.env.ZYLOS_DIR,
    env: { ...process.env, ZYLOS_SESSION_GROUP: 'chat:mine' }, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  caller('chat:mine');
  assert.equal(result.stdout, fetchCli(['--begin', '1', '--end', '5']));
  assert.ok(result.stdout.endsWith(expectedNotes()));
  console.log('History exact output:', JSON.stringify(result.stdout));
});

// Actual JSON CLI entrypoint against this worker's private DB; no services/socket.
// Run for recent/output changes; skip template-only changes. The synchronous
// child is reaped and bounded by the same timeout/output limits as the fetch child.
test('History recent CLI remains parseable JSON with foreign rows and a non-origin caller', t => {
  seed(t);
  caller(undefined);
  const before = databaseCli(['recent', '5']);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../skills/comm-bridge/scripts/c4-db.js', import.meta.url)),
    'recent', '5'], { cwd: process.env.ZYLOS_DIR,
    env: { ...process.env, ZYLOS_SESSION_GROUP: 'chat:mine' }, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, before, 'recent bytes are independent of the caller group');
  const rows = JSON.parse(result.stdout);
  assert.equal(rows.length, 5);
  assert.equal(rows.filter(row => row.session_group === 'chat:peer').length, 2);
  for (const row of rows) assert.equal(row.content, `message ${row.id}`);
  assert.equal(result.stdout.includes('Note:'), false);
});
