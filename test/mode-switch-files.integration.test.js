import { test, afterEach } from '@jest/globals';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fixture as storeFixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { createModeSwitchConverter } from '../skills/activity-monitor/scripts/mode-switch-convert.js';
import { renderStateSkeleton } from '../skills/zylos-memory/scripts/state-format.js';
import { replyVia } from '../skills/comm-bridge/scripts/c4-query-format.js';
import { writeModeSwitchFile, parseModeSwitchHeader } from '../cli/lib/mode-switch-files.js';

const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });
function fixture(source = 'single', suffix = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-switch-files-' + suffix));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const { db, store } = storeFixture({ after: fn => cleanups.push(fn) }, { now: () => 1800000000000 }, path.join(root, 'c4.db'));
  db.pragma('journal_mode = WAL');
  const put = (relative, body) => { const file = path.join(root, 'memory', relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file; };
  const add = (group = 'a', body = 'message', endpoint = 'e') => store.insertConversation('in', 'foo', endpoint, body, { groupName: group });
  const begin = () => { const { runId } = store.beginModeTransition(source, source === 'single' ? 'multi' : 'single'); store.setDrainFence('*'); store.absorbForTransition(runId); return store.getModeTransition(); };
  const read = relative => fs.readFileSync(path.join(root, 'memory', relative), 'utf8');
  return { root, db, store, put, add, begin, read, convert: options => createModeSwitchConverter({ db: store, zylosDir: root, ...options }) };
}
function memoryTree(root) {
  const result = {};
  function visit(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) visit(file); else result[path.relative(root, file)] = fs.readFileSync(file, 'utf8'); } }
  visit(path.join(root, 'memory')); return result;
}
function snapshotDb(db) { return ['conversations', 'mode_transitions', 'drain_fences', 'checkpoints'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); }

test('single→multi preserves source and archives target once; all 1000 Pending rows and empty-scope input survive byte-identical replay', () => {
  const f = fixture(); f.put('state.md', 'source state'); f.put('inbox.md', 'source inbox'); f.put('handoff.md', 'source handoff');
  f.put('session-groups/foo:a/state.md', 'old target'); f.put('session-groups/foo:a/inbox.20261027T090000000Z.md', 'old segment'); f.put('session-groups/origin/handoff.md', 'old target handoff');
  for (let n = 0; n < 1000; n++) f.add('a', n === 0 ? '汉'.repeat(300) + '\n\t\0' : n === 1 ? '' : `message${n}`, "route'$(`touch nope`)" + 'x'.repeat(200));
  f.db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group) VALUES('in','old','legacy','unscoped','pending','')").run();
  f.db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group) VALUES('out','old','legacy','raw\\nexport','delivered','')").run();
  const row = f.begin(); const before = snapshotDb(f.db); const out = f.convert()(row);
  assert.deepEqual(snapshotDb(f.db), before); assert.deepEqual(out.scopes, ['foo:a', 'origin']);
  assert.equal(f.read('state.md'), 'source state'); assert.equal(f.read('handoff.md'), 'source handoff');
  assert.equal(f.read(`mode-switch/${row.run_id}/previous/foo:a/state.md`), 'old target');
  assert.equal(f.read(`mode-switch/${row.run_id}/previous/foo:a/inbox.20261027T090000000Z.md`), 'old segment');
  const state = f.read('session-groups/foo:a/state.md'); assert.equal(state.split('\n').filter(line => /^- #\d+ /.test(line)).length, 1000);
  assert.match(state, /（无正文）/); assert.match(state, /截断，全文见 #1/); assert.ok(state.length > 50000);
  assert.match(f.read('session-groups/origin/state.md'), /unscoped/);
  const header = parseModeSwitchHeader(fs.readFileSync(out.handoff, 'utf8')); assert.equal(header.runId, row.run_id); assert.equal(header.cutoff, row.cutoff);
  assert.ok(out.materials.includes(path.join(f.root, 'memory', `mode-switch/${row.run_id}/previous/origin/handoff.md`)));
  const tree = memoryTree(f.root); f.convert()(row); assert.deepEqual(memoryTree(f.root), tree);
  const late = f.add('late', 'not absorbed'); f.convert()(row); assert.match(f.read('session-groups/foo:late/state.md'), /scope=foo:late/); assert.doesNotMatch(f.read('session-groups/foo:late/state.md'), /切换来信/);
  assert.equal(f.read('session-groups/foo:a/state.md'), state); assert.equal(f.store.getModeTransition().cutoff, row.cutoff); assert.equal(f.db.prepare('SELECT status FROM conversations WHERE id=?').get(late.id).status, 'pending');
});

test('#4b converts every absorbed summary across more than 200 scopes', () => {
  const f = fixture(); for (let n = 0; n < 205; n++) f.add('g' + n); const row = f.begin(); const out = f.convert()(row);
  assert.equal(out.scopes.length, 206); const handoff = fs.readFileSync(out.handoff, 'utf8'); assert.equal(handoff.split('\n').filter(line => line.startsWith('- scope=')).length, 205);
});

test('multi→single retains dormant source groups outside coverage snapshot and deterministic export bytes', () => {
  const f = fixture('multi'); f.add('active', 'pending');
  const done = f.store.insertConversation('out', 'foo', 'e', 'already covered', { groupName: 'sleep', wholeGroup: true });
  f.store.createCheckpoint(done.session_group, done.id, 'covered');
  f.put('session-groups/foo:sleep/state.md', 'dormant state'); const old = f.put('session-groups/foo:sleep/handoff.md', 'unfinished dormant handoff');
  f.put('session-groups/origin/state.md', 'origin'); f.put('state.md', 'old global'); f.put('handoff.md', 'old global handoff');
  const row = f.begin(); assert.ok(!Object.hasOwn(row.coverage_snapshot, 'foo:sleep'));
  const out = f.convert()(row); assert.ok(out.materials.includes(old)); assert.equal(fs.readFileSync(old, 'utf8'), 'unfinished dormant handoff');
  assert.match(f.read('state.md'), /scope=\*/); assert.match(f.read('state.md'), /foo:active foo e/);
  assert.equal(f.read(`mode-switch/${row.run_id}/previous/_global/handoff.md`), 'old global handoff');
  const tree = memoryTree(f.root); f.convert()(row); assert.deepEqual(memoryTree(f.root), tree);
});

for (const direction of ['single', 'multi']) test(`${direction} archive conflicts preserve both copies and recover without replacing archived data`, () => {
  const f = fixture(direction); f.add(); const row = f.begin(); const target = direction === 'single' ? 'session-groups/foo:a' : '.'; const previous = `mode-switch/${row.run_id}/previous/${direction === 'single' ? 'foo:a' : '_global'}`;
  f.put(`${target}/state.md`, 'new source conflict'); f.put(`${previous}/state.md`, 'original archive');
  assert.throws(() => f.convert()(row), { code: 'EEXIST', step: 'archive' });
  assert.equal(f.read(`${target}/state.md`), 'new source conflict'); assert.equal(f.read(`${previous}/state.md`), 'original archive'); assert.ok(f.store.getDrainFence('*'));
  fs.renameSync(path.join(f.root, 'memory', target, 'state.md'), path.join(f.root, 'operator-preserved-state.md'));
  f.convert()(row); assert.equal(f.read(`${previous}/state.md`), 'original archive');
});

for (const failurePoint of ['archive', 'skeleton', 'handoff']) test(`failure after ${failurePoint} restarts with byte-identical final files and source untouched`, () => {
  const f = fixture(); f.add(); f.put('state.md', 'source'); f.put('session-groups/foo:a/state.md', 'old'); f.put('session-groups/foo:a/inbox.md', 'old inbox'); const row = f.begin();
  const expectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-switch-reference-')); cleanups.push(() => fs.rmSync(expectedRoot, { recursive: true, force: true }));
  fs.cpSync(path.join(f.root, 'memory'), path.join(expectedRoot, 'memory'), { recursive: true });
  createModeSwitchConverter({ db: f.store, zylosDir: expectedRoot })(row);
  let fired = false;
  const fsImpl = { ...fs, renameSync(a, b) { fs.renameSync(a, b); const match = failurePoint === 'archive' ? b.includes('/previous/') && !b.endsWith('/.done') : failurePoint === 'skeleton' ? b.endsWith('/state.md') && !b.includes('/previous/') : b.endsWith('/handoff.md') && !b.includes('/previous/'); if (!fired && match) { fired = true; throw Object.assign(new Error('injected interrupted I/O'), { code: 'EIO' }); } } };
  assert.throws(() => f.convert({ fsImpl })(row), { code: 'EIO' }); assert.ok(fired); f.convert()(row);
  const expected = memoryTree(expectedRoot); for (const key of Object.keys(expected)) expected[key] = expected[key].replaceAll(expectedRoot, f.root);
  assert.deepEqual(memoryTree(f.root), expected); assert.equal(f.read('state.md'), 'source');
});

test('missing absorbed row aborts before any archive or target write', () => {
  const f = fixture(); const message = f.add(); const row = f.begin(); f.put('session-groups/foo:a/state.md', 'old'); const tree = memoryTree(f.root);
  f.db.prepare('DELETE FROM conversations WHERE id=?').run(message.id);
  assert.throws(() => f.convert()(row), { code: 'ABSORBED_MISMATCH', step: 'check' }); assert.deepEqual(memoryTree(f.root), tree);
});

for (const mutant of ['drop-pending', 'append-state', 'omit-old-handoff']) test(`completion check rejects on-disk ${mutant}, normal writer passes same fixture`, () => {
  const f = fixture(); f.add(); f.put('session-groups/origin/handoff.md', 'old handoff'); const row = f.begin(); f.convert()(row);
  const writeFile = (file, text, options) => {
    if (mutant === 'drop-pending' && file.endsWith('state.md')) text = text.replace(/^- #\d+ .*\n/m, '');
    if (mutant === 'append-state' && file.endsWith('state.md')) text += text;
    if (mutant === 'omit-old-handoff' && file.endsWith('handoff.md')) text = text.split('\n').filter(line => !line.startsWith('- material: ') || !line.includes('previous/')).join('\n');
    return writeModeSwitchFile(file, text, options);
  };
  assert.throws(() => f.convert({ writeFile })(row), { code: 'ABSORBED_MISMATCH', step: 'check' }); f.convert()(row);
});

for (const suffix of ["space ' $(not-run) ", 'control\n']) test(`actual commands preserve script path and IDs for ${JSON.stringify(suffix)}`, () => {
  const f = fixture('single', suffix); f.add('a', 'text', "'; touch injected; '"); const row = f.begin(); const out = f.convert()(row); const handoff = fs.readFileSync(out.handoff, 'utf8');
  const commands = handoff.split('\n').filter(line => line.startsWith('node '));
  if (suffix.includes('\n')) { assert.equal(commands.length, 0); assert.ok(handoff.includes(replyVia({ id: 1 }, path.join(f.root, '.claude/skills/comm-bridge/scripts/c4-send.js')))); return; }
  assert.equal(commands.length, 2);
  const scripts = path.join(f.root, '.claude/skills/comm-bridge/scripts'); fs.mkdirSync(scripts, { recursive: true });
  for (const name of ['c4-send.js', 'c4-fetch.js']) fs.writeFileSync(path.join(scripts, name), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const replies = commands.map(command => { const r = spawnSync('sh', ['-c', command], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); });
  assert.deepEqual(replies, [['--absorbed-reply', row.run_id, '1'], ['--absorbed', '--run-id', row.run_id, '--id', '1']]);
});

for (const source of ['single', 'multi']) for (const point of ['archive', 'skeleton', 'handoff']) test(`real SIGKILL ${source} after ${point} resumes same run/cutoff and exact output`, () => {
  const f = fixture(source); f.add(); f.put('state.md', 'global old'); f.put('inbox.md', 'global inbox'); f.put('handoff.md', 'global handoff');
  f.put('session-groups/foo:a/state.md', 'group old'); f.put('session-groups/foo:a/inbox.md', 'group inbox'); f.put('session-groups/origin/handoff.md', 'origin handoff');
  const row = f.begin(); const beforeDb = snapshotDb(f.db);
  const expectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-switch-crash-reference-')); cleanups.push(() => fs.rmSync(expectedRoot, { recursive: true, force: true }));
  fs.cpSync(path.join(f.root, 'memory'), path.join(expectedRoot, 'memory'), { recursive: true });
  createModeSwitchConverter({ db: f.store, zylosDir: expectedRoot })(row);
  const child = spawnSync(process.execPath, [new URL('./helpers/mode-switch-convert-child.js', import.meta.url).pathname, f.root, point], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr); assert.deepEqual(snapshotDb(f.db), beforeDb);
  const retry = spawnSync(process.execPath, [new URL('./helpers/mode-switch-convert-child.js', import.meta.url).pathname, f.root, 'none'], { encoding: 'utf8' });
  assert.equal(retry.status, 0, retry.stderr); assert.deepEqual(snapshotDb(f.db), beforeDb);
  const expected = memoryTree(expectedRoot); for (const key of Object.keys(expected)) expected[key] = expected[key].replaceAll(expectedRoot, f.root);
  assert.deepEqual(memoryTree(f.root), expected);
});

test('successive reverse conversions retain old handoff entrypoints without claiming semantic completion', () => {
  const f = fixture(); f.add(); f.put('state.md', 'old single'); f.put('handoff.md', 'uncompleted single handoff');
  const first = f.begin(); const a = f.convert()(first);
  f.store.setModeTransitionPhase(first.run_id, 'cutover'); f.store.setModeTransitionPhase(first.run_id, 'complete');
  const secondRun = f.store.beginModeTransition('multi', 'single'); f.store.setDrainFence('*'); f.store.absorbForTransition(secondRun.runId); const second = f.store.getModeTransition();
  const b = f.convert()(second); assert.ok(b.materials.includes(a.handoff));
  assert.match(fs.readFileSync(b.handoff, 'utf8'), /多代固定路径身份不明时报告人工核对/);
  assert.equal(f.read(`mode-switch/${second.run_id}/previous/_global/handoff.md`), 'uncompleted single handoff');
  const stable = memoryTree(f.root); f.convert()(second); assert.deepEqual(memoryTree(f.root), stable);
});

for (const source of ['single', 'multi']) test(`W6 ${source} exports exact original bytes and fixed fields within cutoff`, () => {
  const f = fixture(source);
  const payloads = ['', '汉🙂'.repeat(12000) + '\n\r\t\0', "quotes '\" \\ $(touch nope) `echo nope`"];
  const insert = f.db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group,timestamp) VALUES(?,?,?,?,?,?,?)");
  for (const [index, content] of payloads.entries()) insert.run(index % 2 ? 'in' : 'out', 'foo', "route\n'\\", content, 'delivered', source === 'single' ? '' : 'foo:a', 1800000000 + index);
  if (source === 'multi') f.db.prepare("INSERT INTO group_heads(session_group,head_id) VALUES('foo:a',3)").run();
  f.add('pending'); const row = f.begin();
  const expected = f.db.prepare("SELECT id,direction,channel,endpoint_id,timestamp,content FROM conversations WHERE status='delivered' ORDER BY id").all().map(r => ({ id: r.id, direction: r.direction, channel: r.channel, endpoint: r.endpoint_id, timestamp: r.timestamp, content: r.content }));
  const out = f.convert()(row);
  const file = out.materials.find(name => name.endsWith(source === 'single' ? '/ungrouped.md' : '/foo:a.md'));
  assert.ok(file, JSON.stringify(out.materials)); const bytes = fs.readFileSync(file, 'utf8');
  assert.equal(bytes, expected.map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.deepEqual(bytes.trimEnd().split('\n').map(line => JSON.parse(line)), JSON.parse(JSON.stringify(expected)));
  insert.run('out', 'foo', 'late', 'after cutoff', 'delivered', source === 'single' ? '' : 'foo:a', 1800000010);
  f.convert()(row); assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

for (const point of ['export', 'check']) test(`conversion ${point} I/O failure preserves D9 and recovers`, () => {
  const f = fixture(); f.add(); const row = f.begin(); const before = snapshotDb(f.db); let fired = false;
  const fsImpl = { ...fs,
    renameSync(a, b) { if (point === 'export' && b.endsWith('/ungrouped.md')) { fired = true; throw Object.assign(new Error('injected export I/O'), { code: 'EIO' }); } return fs.renameSync(a, b); },
    readFileSync(file, ...args) { if (point === 'check' && String(file).endsWith('/state.md')) { fired = true; throw Object.assign(new Error('injected check I/O'), { code: 'EACCES' }); } return fs.readFileSync(file, ...args); },
  };
  assert.throws(() => f.convert({ fsImpl })(row), { step: point, code: point === 'export' ? 'EIO' : 'EACCES' });
  assert.equal(fired, true); assert.deepEqual(snapshotDb(f.db), before);
  f.convert()(row); assert.deepEqual(snapshotDb(f.db), before);
});

for (const source of ['single', 'multi']) test(`${source} recovery materials contain all source files but only previous target handoffs`, () => {
  const f = fixture(source); f.add('a');
  const sourceDir = source === 'single' ? '' : 'session-groups/foo:a/';
  const targetDir = source === 'single' ? 'session-groups/foo:a/' : '';
  const names = ['state.md', 'inbox.md', 'inbox.20261027T090000000Z.md', 'inbox.20261027T090000000Z-2.md', 'handoff.md'];
  const sourceFiles = names.map(name => f.put(sourceDir + name, 'source ' + name));
  for (const name of names) f.put(targetDir + name, 'previous ' + name);
  const row = f.begin(); const out = f.convert()(row);
  const scope = source === 'single' ? 'foo:a' : '_global';
  const exportFiles = source === 'single' ? ['ungrouped.md'] : Object.keys(row.coverage_snapshot).map(group => group + '.md');
  const expected = [...sourceFiles, path.join(f.root, 'memory', `mode-switch/${row.run_id}/previous/${scope}/handoff.md`),
    ...exportFiles.map(name => path.join(f.root, 'memory', `mode-switch/${row.run_id}`, name))].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  assert.deepEqual(out.materials, expected);
  const listed = fs.readFileSync(out.handoff, 'utf8').split('\n').filter(line => line.startsWith('- material: ')).map(line => JSON.parse(line.slice(12)));
  assert.deepEqual(listed, expected);
  for (const name of names) assert.equal(f.read(`mode-switch/${row.run_id}/previous/${scope}/${name}`), 'previous ' + name);
  assert.deepEqual(f.convert()(row).materials, expected);
});

test('renderer dropping one Pending entry while retaining the heading fails check and retains /gate', () => {
  const f = fixture(); f.add('a', 'first'); f.add('a', 'second');
  const row = f.begin(); const before = snapshotDb(f.db); let removed = false;
  const renderState = options => {
    const text = renderStateSkeleton(options);
    const result = text.replace(/^- #\d+ .*\n/m, '');
    if (result !== text) removed = true;
    assert.ok(result.includes('\n## Pending\n'));
    return result;
  };
  assert.throws(() => f.convert({ renderState })(row), { code: 'ABSORBED_MISMATCH', step: 'check' });
  assert.equal(removed, true); assert.deepEqual(snapshotDb(f.db), before);
  assert.equal(f.store.getModeTransition().phase, 'converting'); assert.ok(f.store.getDrainFence('*'));
  f.convert()(row); assert.deepEqual(snapshotDb(f.db), before);
});

test('W6 single ungrouped export excludes grouped rows inside the same cutoff', () => {
  const f = fixture();
  const insert = f.db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group) VALUES('out','foo','endpoint',?,'delivered',?)");
  insert.run('only ungrouped one', ''); insert.run('excluded grouped', 'foo:a'); insert.run('only ungrouped two', '');
  f.add('pending'); const row = f.begin();
  const expected = f.db.prepare("SELECT id,direction,channel,endpoint_id,timestamp,content FROM conversations WHERE session_group='' AND id<=? ORDER BY id").all(row.cutoff)
    .map(r => ({ id: r.id, direction: r.direction, channel: r.channel, endpoint: r.endpoint_id, timestamp: r.timestamp, content: r.content }));
  const out = f.convert()(row); const file = out.materials.find(name => name.endsWith('/ungrouped.md'));
  assert.deepEqual(fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line)), JSON.parse(JSON.stringify(expected)));
  assert.equal(expected.length, 2);
});

test('empty absorbed set needs no command even when the Core path contains control characters', () => {
  const f = fixture('single', 'control\n'); const row = f.begin();
  const out = f.convert()(row); const handoff = fs.readFileSync(out.handoff, 'utf8');
  assert.ok(handoff.includes('本次没有被吸收来信，无需按 id 回复或读取全文。'));
  assert.equal(handoff.split('\n').filter(line => line.startsWith('node ') || line.startsWith('---- reply via:')).length, 0);
});
