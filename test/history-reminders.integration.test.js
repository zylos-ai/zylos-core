import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const { DB_PATH } = await import('../skills/comm-bridge/scripts/c4-config.js');
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
  db.exec('DELETE FROM conversations; DELETE FROM checkpoints; DELETE FROM group_heads;');
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

test('history reads preserve baseline bytes for Origin, JSON and scoped coverage', t => {
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
  const coverageReaders = [
    ['unsummarized', () => fetchCli(['--unsummarized'])],
    ['scoped unsummarized', () => fetchCli(['--unsummarized', '--group', 'chat:peer'])],
    ['database unsummarized', () => databaseCli(['unsummarized'])],
    ['fetch checkpoints', () => fetchCli(['--checkpoints', '--after', '0'])],
    ['database checkpoints', () => databaseCli(['checkpoints'])],
  ];
  for (const [name, read] of coverageReaders) {
    caller(undefined); const before = read();
    caller('chat:mine'); const after = read();
    assert.equal(after, before, `${name}: caller-independent bytes`);
    assert.equal(after.includes('Note:'), false, `${name}: no reminder`);
    outputs++;
  }
  assert.equal(outputs, 17);
  console.log('History compatibility:', JSON.stringify({ outputs }));
});
