import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildAnnotatedContent } from '../attachment-annotations.js';

// Allocate this file's database before any production module reads its paths;
// the official runner may execute other files concurrently under the same HOME.
const runnerHome = fs.realpathSync(process.env.HOME);
assert.equal(path.basename(runnerHome), 'home');
assert.match(path.basename(path.dirname(runnerHome)), /^zylos-tests-/);
const fileRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-quotes-')));
const previous = {};
for (const [key, leaf] of [['HOME', 'home'], ['ZYLOS_DIR', 'home/zylos'], ['PM2_HOME', 'home/.pm2'], ['TMPDIR', 'tmp']]) {
  previous[key] = process.env[key];
  process.env[key] = path.join(fileRoot, leaf);
  fs.mkdirSync(process.env[key], { recursive: true });
}
const { fetchCli } = await import('../c4-public-cli.js');
const { getDb, close } = await import('../c4-db.js');
const { DB_PATH, SKILLS_DIR } = await import('../c4-config.js');
after(() => {
  try { close(); fs.rmSync(fileRoot, { recursive: true, force: true }); }
  finally { for (const [key, value] of Object.entries(previous)) process.env[key] = value; }
});

const group = 'dashboard:history';
const modes = [
  ['unsummarized', ['--unsummarized', '--group', group, '--after', '99']],
  ['since', ['--since', '2026-01-02']],
  ['range', ['--begin', '100', '--end', '199']],
  ['origin raw', ['--origin-sync', '--raw-only', '--group', group, '--after', '99']],
];
function fixture(t) {
  const root = fs.realpathSync(process.env.HOME);
  assert.notEqual(root, fs.realpathSync(os.userInfo().homedir));
  for (const key of ['ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    const value = process.env[key];
    const canonical = fs.existsSync(value) ? fs.realpathSync(value) : path.join(fs.realpathSync(path.dirname(value)), path.basename(value));
    assert.ok(canonical.startsWith(path.dirname(root) + path.sep));
    fs.mkdirSync(process.env[key], { recursive: true });
    assert.ok(fs.realpathSync(process.env[key]).startsWith(path.dirname(root) + path.sep));
  }
  assert.ok(DB_PATH.startsWith(process.env.ZYLOS_DIR + path.sep));
  console.log('History quote isolation:', JSON.stringify({ HOME: root, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, database: DB_PATH, tmux: 'not launched' }));
  const db = getDb();
  db.exec('DELETE FROM conversations; DELETE FROM checkpoints; DELETE FROM group_heads; DELETE FROM origin_sync_cursors;');
  const memory = path.join(process.env.ZYLOS_DIR, 'memory'); fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(path.join(memory, 'references.md'), '# References\n\n## Active IDs\n- Owner: Test Owner (private fixture)\n');
  const oldCaller = process.env.ZYLOS_SESSION_GROUP;
  process.env.ZYLOS_SESSION_GROUP = 'telegram:reader';
  t.after(() => { close(); if (oldCaller === undefined) delete process.env.ZYLOS_SESSION_GROUP; else process.env.ZYLOS_SESSION_GROUP = oldCaller; });
  const insert = db.prepare(`INSERT INTO conversations(id,timestamp,direction,channel,endpoint_id,session_group,content,status)
    VALUES(@id,@timestamp,@direction,@channel,@endpoint_id,@session_group,@content,'delivered')`);
  const add = row => insert.run({ timestamp: row.id < 100 ? '2026-01-01 00:00:00' : '2026-01-02 00:00:00',
    direction: 'out', channel: 'dashboard', endpoint_id: 'history', session_group: group, content: 'target', ...row });
  const ready = () => db.prepare('INSERT OR REPLACE INTO group_heads(session_group,head_id) VALUES(?,199)').run(group);
  return { db, add, ready };
}
function seedValid(f) {
  const files = [{ kind: 'file', name: 'report.txt', path: '/private/secret/report.txt', size: 4 }];
  f.add({ id: 1, content: buildAnnotatedContent('[quote c4_id=9]\n**AI words**', files) });
  f.add({ id: 2, direction: 'in', content: 'Owner words' });
  f.add({ id: 3, direction: 'in', channel: 'internal', endpoint_id: 'telegram:peer', content: '[internal] telegram:peer said: [quote c4_id=1]\nPeer words' });
  f.add({ id: 4, direction: 'in', channel: 'internal', endpoint_id: 'origin', content: '[internal] Yourself, from your "origin" session group, said: Other peer' });
  f.add({ id: 5, channel: 'internal', endpoint_id: 'telegram:peer', content: 'Sent internally' });
  f.add({ id: 6, content: '😀'.repeat(161) });
  f.add({ id: 7, content: '一'.repeat(160) });
  for (let id = 1; id <= 7; id++) f.add({ id: 100 + id, direction: 'in', content: `[quote c4_id=${id}]\nreply-${id}` });
  f.add({ id: 108, direction: 'in', content: '[quote c4_id=1]' });
  f.add({ id: 109, direction: 'in', content: '[quote c4_id=2]\n' });
  f.ready();
}

// Real public formatter + SQLite queries under official runner isolation. No
// services, channels, tmux or model start. Run for history quote formatting,
// lookup or projection changes; skip unrelated delivery and browser changes.
for (const [name, args] of modes) for (const [id, label, sender, preview] of [
  [1, 'AI attachments and nested markers', 'AI', 'AI words （附件：report.txt）'],
  [2, 'owner name', 'Test Owner', 'Owner words'],
  [3, 'internal incoming prefix', 'telegram:peer', 'Peer words'],
  [4, 'legacy internal prefix', 'origin', 'Other peer'],
  [5, 'internal outgoing sender', 'AI', 'Sent internally'],
  [6, 'Unicode truncation', 'AI', '😀'.repeat(160)],
  [7, 'exact character limit', 'AI', '一'.repeat(160)],
]) test(`${name} text quotes ${label}`, t => {
  const f = fixture(t); seedValid(f);
  const output = fetchCli(args);
  assert.ok(output.includes(`[quote c4_id=${id}]\n(quoting c4_id=${id} — ${sender}: ${preview})\nreply-${id}`));
  if (id === 1) assert.ok(output.includes('[quote c4_id=1]\n(quoting c4_id=1 — AI: AI words （附件：report.txt）)\n---- reply via:'));
  if (id === 2) assert.ok(output.includes('[quote c4_id=2]\n(quoting c4_id=2 — Test Owner: Owner words)\n\n---- reply via:'));
  assert.equal(output.includes('/private/secret'), false);
  assert.equal(f.db.prepare('SELECT content FROM conversations WHERE id=101').get().content, '[quote c4_id=1]\nreply-1');
});

// Same public query modes and private DB. Run for quote scope/eligibility
// changes; skip unrelated UI changes. Invalid references keep literal markers.
for (const [name, args] of modes) test(`${name} text leaves unavailable and ineligible references literal`, t => {
  const f = fixture(t);
  f.add({ id: 1, session_group: 'dashboard:foreign' });
  f.add({ id: 2 }); f.db.prepare('DELETE FROM conversations WHERE id=2').run();
  f.add({ id: 3, content: 'available same-group target' });
  f.add({ id: 190 });
  for (const [id, content, extra] of [
    [101, '[quote c4_id=1]\nforeign'], [102, '[quote c4_id=2]\ndeleted'],
    [103, '[quote c4_id=190]\nnewer'], [104, '[quote c4_id=104]\nself'],
    [105, '[quote c4_id=3]\nother channel', { channel: 'telegram' }],
    [106, '[quote c4_id=3]\noutbound', { direction: 'out' }],
    [107, 'intro\n[quote c4_id=1]\nlater marker'], [108, '[quote c4_id=0]\nzero'],
    [109, '[quote c4_id=9007199254740992]\nunsafe'],
  ]) f.add({ id, direction: 'in', content, ...extra });
  f.ready();
  const output = fetchCli(args);
  assert.equal(output.includes('(quoting '), false);
  for (const text of ['foreign', 'deleted', 'newer', 'self', 'other channel', 'outbound', 'later marker', 'zero', 'unsafe']) assert.ok(output.includes(text), text);
  assert.ok(output.includes('[quote c4_id=190]\nnewer'));
});

test('text resolves duplicate references in one ID-limited batch while JSON never resolves them', t => {
  const f = fixture(t); seedValid(f);
  const prepare = f.db.prepare;
  const reads = [];
  f.db.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (/json_each\(/.test(sql)) {
      const all = statement.all;
      statement.all = function(...args) { reads.push(args); return all.apply(this, args); };
    }
    return statement;
  };
  try {
    for (const [, args] of modes) {
      reads.length = 0; fetchCli([...args, '--json']); assert.equal(reads.length, 0);
      fetchCli(args); assert.equal(reads.length, 1);
      assert.equal(reads[0].length, 1);
      assert.equal(JSON.stringify(JSON.parse(reads[0][0]).sort((a, b) => a - b)), '[1,2,3,4,5,6,7]');
    }
  } finally { f.db.prepare = prepare; }
});

test('JSON and unquoted text retain byte-identical public output including foreign-history notes', t => {
  const f = fixture(t); seedValid(f);
  const normalize = value => value.replaceAll(SKILLS_DIR, '$SKILLS');
  const outputs = modes.map(([, args]) => normalize(fetchCli([...args, '--json'])));
  f.db.prepare("UPDATE conversations SET content='plain history' WHERE id>=100").run();
  const prepare = f.db.prepare, statements = [];
  f.db.prepare = function(sql) { statements.push(sql); return prepare.call(this, sql); };
  try {
    for (const [, args] of modes) {
      statements.length = 0; fetchCli([...args, '--json']); const jsonQueries = [...statements];
      statements.length = 0; const text = fetchCli(args); outputs.push(normalize(text));
      assert.equal(JSON.stringify(statements), JSON.stringify(jsonQueries), 'unquoted text does not add a database query');
    }
  } finally { f.db.prepare = prepare; }
  assert.ok(outputs[5].includes('session group dashboard:history; they are history.'));
  const digest = createHash('sha256').update(JSON.stringify(outputs)).digest('hex');
  console.log('Compatibility SHA256:', digest);
  // Captured from the untouched product baseline using these same fixed rows.
  assert.equal(digest, '314f3321c4a48544c20e876c42d6dfcb33a9c50d95c7c1498d59068b36b5020a');
});
