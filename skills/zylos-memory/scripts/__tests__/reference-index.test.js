import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPage, rebuild, movePage, moveOld, checkNavigation } from '../reference-index.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = relative => path.join(root, 'memory', relative);
  const write = (relative, content) => { fs.mkdirSync(path.dirname(target(relative)), { recursive: true }); fs.writeFileSync(target(relative), content); };
  const read = relative => fs.readFileSync(target(relative), 'utf8');
  return { root, target, write, read };
}
const page = (kind, title, status, date, extra = '') => `# ${title}\n<!-- zylos:entry kind=${kind} -->\n- **Status:** ${status}\n- **Updated:** ${date}\n${extra}\n\nBody remains unchanged.\n`;
const code = expected => error => error.code === expected;

test('navigation check reports old paths and heading pointers, then clears after correction', t => {
  const f = fixture(t);
  f.write('references.md', '# References\nRead ~/zylos/memory/reference/projects.md (read-only history).\nRead [decisions](/home/agent/zylos/memory/reference/decisions.md#choice).\n');
  f.write('identity.md', 'See projects.md#current-work\n');
  f.write('reference/projects/current.md', 'See reference/decisions.md#old-choice\n');
  f.write('users/member/profile.md', 'See decisions.md:42\n');
  for (const relative of ['reference/legacy/old.md',
    'reference/projects/INDEX.md', 'session-groups/other/state.md', 'sessions/2026-01-01.md']) {
    f.write(relative, 'reference/projects.md#historical\n');
  }
  f.write('reference/notes.md', 'See projects.md for Project Alpha\nSee reference/legacy/projects.md#old\n');
  f.write('reference/projects/archive/old.md', 'See reference/projects.md#archived\n');
  fs.mkdirSync(f.target('reference/projects.md'), { recursive: true });
  fs.symlinkSync('/unreadable-old-file', f.target('reference/decisions.md'));
  const before = f.read('references.md');
  const result = checkNavigation(f.root);
  assert.equal(result.navigation.count, 2);
  assert.deepEqual(result.navigation.locations.map(row => [row.path, row.line]), [['references.md', 2], ['references.md', 3]]);
  assert.equal(result.headings.count, 7);
  assert.equal(result.headings.locations.some(row => row.path === 'reference/projects/archive/old.md'), true);
  assert.equal(result.headings.locations.some(row => row.path.startsWith('session-groups/')), false);
  assert.equal(f.read('references.md'), before);
  assert.equal(fs.existsSync(path.join(f.root, '.zylos')), false);
  f.write('references.md', 'Read reference/projects/INDEX.md and reference/decisions/INDEX.md\n');
  f.write('identity.md', 'See reference/projects/current.md\n');
  f.write('reference/projects/current.md', 'See reference/decisions/choice.md\n');
  f.write('users/member/profile.md', 'See reference/legacy/decisions-before-split.md#preferences\n');
  f.write('reference/projects/archive/old.md', 'See reference/projects/current.md\n');
  f.write('reference/notes.md', 'See reference/projects/current.md for Project Alpha\nSee reference/legacy/projects.md#old\n');
  assert.deepEqual(checkNavigation(f.root), { navigation: { count: 0, locations: [] }, headings: { count: 0, locations: [] } });
  const cli = new URL('../reference-index.js', import.meta.url);
  const run = () => spawnSync(process.execPath, [cli.pathname, 'check-navigation'], {
    env: { ...process.env, ZYLOS_DIR: f.root }, encoding: 'utf8', timeout: 10000,
  });
  let output = run();
  assert.equal(output.status, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).navigation.count, 0);
  f.write('references.md', 'Read reference/projects.md\n');
  output = run();
  assert.equal(output.status, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).navigation.count, 1);
});

test('navigation check skips missing inputs and refuses symlink traversal', t => {
  const f = fixture(t);
  assert.equal(checkNavigation(f.root).navigation.count, 0);
  f.write('reference/notes.md', 'reference/projects.md#old\n');
  fs.symlinkSync(f.target('reference/notes.md'), f.target('references.md'));
  assert.throws(() => checkNavigation(f.root), code('PATH_NOT_ALLOWED'));
});

test('navigation check recognizes markup and prose punctuation without matching other filenames', t => {
  const f = fixture(t);
  f.write('references.md', [
    'See **reference/projects.md**.',
    'See reference/decisions.md\u3002',
    'See `reference/projects.md`\uFF1A42',
    'Keep reference/projects.md.backup and reference/decisions.md-old.',
    'Keep reference/projects.md/child and reference/legacy/projects.md.',
  ].join('\n'));
  const result = checkNavigation(f.root);
  assert.equal(result.navigation.count, 3);
  assert.deepEqual(result.navigation.locations.map(row => row.line), [1, 2, 3]);
  assert.equal(result.headings.count, 3);
});

test('navigation check excludes only actual legacy sources and generated indexes', t => {
  const f = fixture(t);
  for (const relative of ['users/legacy/profile.md', 'reference/notes/INDEX.md']) {
    f.write(relative, 'See reference/projects.md\n');
  }
  for (const relative of ['reference/legacy/old.md', 'reference/projects/archive/INDEX.md']) {
    f.write(relative, 'See reference/projects.md\n');
  }
  const result = checkNavigation(f.root);
  assert.equal(result.navigation.count, 0);
  assert.deepEqual(result.headings.locations.map(row => row.path),
    ['reference/notes/INDEX.md', 'users/legacy/profile.md']);
});

test('rebuild creates four empty indexes without reading old files', t => {
  const f = fixture(t);
  // A non-file at an old path would fail if rebuild tried to read it.
  fs.mkdirSync(f.target('reference/projects.md'), { recursive: true });
  rebuild(f.root);
  rebuild(f.root);
  for (const kind of ['projects', 'decisions']) for (const suffix of ['', '/archive']) {
    const text = f.read(`reference/${kind}${suffix}/INDEX.md`);
    assert.match(text, /generated by reference-index.js rebuild/);
    assert.equal(text.includes('Unparsable page headers'), false);
    assert.equal(text.includes('- INDEX.md'), false);
    assert.match(text, kind === 'projects' ? /Project \| File \| Keys/ : /Topic \| File \| Scope/);
    assert.equal(text.split('\n').filter(line => /^\| (active|planning|paused|completed|abandoned|archived) /.test(line)).length, 0);
  }
});

test('rebuild sorts headers and separates malformed pages while ignoring other levels', t => {
  const f = fixture(t), base = 'reference/projects/';
  const entries = [
    ['abandoned.md', 'abandoned', '2026-11-11'], ['completed.md', 'completed', '2026-11-11'],
    ['paused.md', 'paused', '2026-11-11'], ['planning.md', 'planning', '2026-11-11'],
    ['older.md', 'active', '2026-10-01'], ['newer.md', 'active', '2026-11-10'],
  ];
  for (const [name, status, updated] of entries) f.write(base + name, page('projects', name === 'newer.md' ? '项目 | 最新' : name, status, updated, '- **Keys:** alias | key'));
  const bad = {
    'no-title.md': '<!-- zylos:entry kind=projects -->\n- **Status:** active\n- **Updated:** 2026-11-11',
    'wrong-kind.md': page('decisions', 'Wrong kind', 'active', '2026-11-11'),
    'wrong-status.md': page('projects', 'Wrong status', 'archived', '2026-11-11'),
    'wrong-date.md': page('projects', 'Wrong date', 'active', '2026-02-30'),
    'body-fields.md': '# Body fields\n\n<!-- zylos:entry kind=projects -->\n- **Status:** active\n- **Updated:** 2026-11-11',
    'missing-field.md': '# Missing\n<!-- zylos:entry kind=projects -->\n- **Status:** active\n',
  };
  for (const [name, text] of Object.entries(bad)) f.write(base + name, text);
  for (const name of ['.hidden.md', 'draft.md.tmp', 'nested/ignored.md']) f.write(base + name, page('projects', 'Ignored', 'active', '2026-11-11'));
  f.write(base + 'archive/stored.md', page('projects', 'Archived project', 'completed', '2026-09-01'));
  f.write('reference/decisions/topic.md', page('decisions', 'Topic', 'active', '2026-11-11', '- **Scope:** security | privacy'));
  f.write('reference/decisions/archive/old.md', page('decisions', 'Old topic', 'archived', '2026-10-10'));
  const original = f.read(base + 'newer.md');
  rebuild(f.root);
  const text = f.read(base + 'INDEX.md'), [main, malformed] = text.split('## Unparsable page headers');
  assert.deepEqual(main.split('\n').filter(line => /^\| (active|planning|paused|completed|abandoned) /.test(line)).map(line => line.split('|')[4].trim()),
    ['newer.md', 'older.md', 'planning.md', 'paused.md', 'completed.md', 'abandoned.md']);
  assert.match(main, /项目 ／ 最新/); assert.match(main, /alias ／ key/);
  for (const name of Object.keys(bad)) { assert.equal(main.includes(name), false); assert.equal(malformed.includes(name), true); }
  for (const ignored of ['Ignored', 'stored.md']) assert.equal(text.includes(ignored), false);
  assert.match(f.read(base + 'archive/INDEX.md'), /Archived project/);
  assert.match(f.read('reference/decisions/INDEX.md'), /security ／ privacy/);
  assert.match(f.read('reference/decisions/archive/INDEX.md'), /archived \| 2026-10-10 \| Old topic/);
  assert.equal(f.read(base + 'newer.md'), original);
  assert.equal(fs.readdirSync(f.target(base)).some(name => name.endsWith('.tmp') && name !== 'draft.md.tmp'), false);
});

test('create publishes exact bytes and refuses existing files and invalid page paths', t => {
  const f = fixture(t), bytes = Buffer.from([0, 0xff, 0x0a, 0xc3, 0xa9]);
  for (const name of ['reference/projects/item.md', 'reference/decisions/topic.md', `reference/projects/${'a'.repeat(45)}.md`]) {
    createPage(f.root, name, bytes);
    assert.equal(fs.readFileSync(f.target(name)).equals(bytes), true);
    assert.throws(() => createPage(f.root, name, 'replacement'), code('EXISTS'));
    assert.equal(fs.readFileSync(f.target(name)).equals(bytes), true);
  }
  for (const name of ['reference/projects/INDEX.md', 'reference/projects/archive/item.md', 'reference/projects/中文.md',
    'reference/projects/Upper.md', 'reference/projects/nested/item.md', 'reference/projects/../item.md',
    `reference/projects/${'a'.repeat(46)}.md`, 'reference/reorg-progress.md', 'reference/legacy/item.md', 'identity.md']) {
    assert.throws(() => createPage(f.root, name, 'no'), code('PATH_NOT_ALLOWED'));
  }
});

test('archive and unarchive preserve content and rebuild both indexes', t => {
  const f = fixture(t);
  for (const kind of ['projects', 'decisions']) {
    const source = `reference/${kind}/item.md`, destination = `reference/${kind}/archive/item.md`;
    const content = page(kind, 'Item', 'active', '2026-11-11');
    f.write(source, content);
    movePage(f.root, source);
    assert.equal(fs.existsSync(f.target(source)), false); assert.equal(f.read(destination), content);
    assert.match(f.read(`reference/${kind}/archive/INDEX.md`), /item.md/);
    assert.equal(f.read(`reference/${kind}/INDEX.md`).includes('| item.md |'), false);
    movePage(f.root, destination, true);
    assert.equal(f.read(source), content); assert.equal(fs.existsSync(f.target(destination)), false);
    assert.match(f.read(`reference/${kind}/INDEX.md`), /item.md/);
    assert.equal(f.read(`reference/${kind}/archive/INDEX.md`).includes('| item.md |'), false);
  }
});

test('archive and unarchive conflicts change neither pages nor indexes', t => {
  const f = fixture(t), source = 'reference/projects/item.md', destination = 'reference/projects/archive/item.md';
  f.write(source, 'current bytes'); f.write(destination, 'archived bytes'); rebuild(f.root);
  const before = f.read('reference/projects/INDEX.md');
  for (const [name, reverse] of [[source, false], [destination, true]]) {
    assert.throws(() => movePage(f.root, name, reverse), code('EXISTS'));
    assert.equal(f.read(source), 'current bytes'); assert.equal(f.read(destination), 'archived bytes');
    assert.equal(f.read('reference/projects/INDEX.md'), before);
  }
});

test('move-old moves available old files unchanged and skips missing files', t => {
  const f = fixture(t), now = new Date(2026, 10, 11, 10, 15, 30), bytes = Buffer.from([0, 255, 10]);
  for (const name of ['projects', 'decisions']) f.write(`reference/${name}.md`, bytes);
  f.write('reference/reorg-progress.md', 'unrelated file');
  const result = moveOld(f.root, now);
  assert.deepEqual(result.paths, [
    'reference/legacy/projects-before-split-20261111-101530.md',
    'reference/legacy/decisions-before-split-20261111-101530.md',
  ]);
  for (const name of ['projects', 'decisions']) {
    assert.equal(fs.existsSync(f.target(`reference/${name}.md`)), false);
    assert.equal(fs.readFileSync(f.target(result.paths[['projects', 'decisions'].indexOf(name)])).equals(bytes), true);
  }
  assert.equal(f.read('reference/reorg-progress.md'), 'unrelated file');
  assert.equal(moveOld(f.root, now).paths.length, 0);
});

test('move-old collision preserves all old files and the existing archive', t => {
  const f = fixture(t), now = new Date(2026, 10, 11, 10, 15, 30);
  f.write('reference/projects.md', 'projects bytes'); f.write('reference/decisions.md', 'decisions bytes');
  const target = 'reference/legacy/decisions-before-split-20261111-101530.md';
  f.write(target, 'existing archive');
  assert.throws(() => moveOld(f.root, now), code('EXISTS'));
  assert.equal(f.read('reference/projects.md'), 'projects bytes'); assert.equal(f.read('reference/decisions.md'), 'decisions bytes');
  assert.equal(f.read(target), 'existing archive');
  assert.equal(fs.readdirSync(f.target('reference/legacy')).length, 1);
});

test('move-old reports a late collision after retaining an earlier completed move', t => {
  const f = fixture(t), now = new Date(2026, 10, 11, 10, 15, 30);
  f.write('reference/projects.md', 'project bytes');
  f.write('reference/decisions.md', 'decision bytes');
  const project = 'reference/legacy/projects-before-split-20261111-101530.md';
  const decision = 'reference/legacy/decisions-before-split-20261111-101530.md';
  const link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (source, destination) => {
    if (destination === f.target(decision)) fs.writeFileSync(destination, 'concurrent archive', { flag: 'wx' });
    return link(source, destination);
  });
  assert.throws(() => moveOld(f.root, now), code('EXISTS'));
  assert.equal(f.read(project), 'project bytes');
  assert.equal(fs.existsSync(f.target('reference/projects.md')), false);
  assert.equal(f.read('reference/decisions.md'), 'decision bytes');
  assert.equal(f.read(decision), 'concurrent archive');
});

test('reference operations reject symlinks escaping their permitted destinations', t => {
  const f = fixture(t);
  fs.mkdirSync(f.target('reference'), { recursive: true });
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, f.target('reference/projects'));
  assert.throws(() => createPage(f.root, 'reference/projects/item.md', 'no'), code('PATH_NOT_ALLOWED'));
  assert.throws(() => rebuild(f.root), code('PATH_NOT_ALLOWED'));
  assert.equal(fs.readdirSync(outside).length, 0);
});

// Integration boundary: CLI parsing, byte stdin and real filesystem publication.
// Run for reference CLI changes; skip for unrelated memory prompt changes.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR before import;
// each child below gets its fixture ZYLOS_DIR. No tmux or database is used.
// All children have a timeout, run synchronously and fixtures are removed by t.after.
test('CLI dispatches all five commands and reports EXISTS without overwriting', t => {
  const f = fixture(t);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key]);
    assert.equal(path.resolve(process.env[key]).startsWith(path.resolve(os.userInfo().homedir) + path.sep), false);
  }
  t.diagnostic(JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: f.root, PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, tmux: 'unused', database: 'unused' }));
  const run = (args, input) => spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../reference-index.js'), ...args], {
    env: { ...process.env, ZYLOS_DIR: f.root }, input, encoding: 'utf8', timeout: 5000,
  });
  const name = 'reference/projects/item.md', content = page('projects', 'CLI', 'active', '2026-11-11');
  for (const args of [['create', '--path', name], ['rebuild'], ['archive', '--path', name], ['unarchive', '--path', 'reference/projects/archive/item.md']]) {
    const result = run(args, content); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ok, true);
  }
  const conflict = run(['create', '--path', name], 'overwrite');
  assert.equal(conflict.status, 1); assert.match(conflict.stderr, /EXISTS/); assert.equal(f.read(name), content);
  f.write('reference/projects.md', 'old bytes');
  const moved = run(['move-old']); assert.equal(moved.status, 0, moved.stderr);
  assert.equal(JSON.parse(moved.stdout).paths.length, 1);
  assert.equal(f.read(JSON.parse(moved.stdout).paths[0]), 'old bytes');
  assert.equal(run(['rebuild', '--path', name]).status, 1);
});


test('a destination published during a move is never overwritten', t => {
  const f = fixture(t), source = 'reference/projects/item.md', destination = 'reference/projects/archive/item.md';
  f.write(source, 'source bytes');
  const link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (from, to) => {
    fs.writeFileSync(to, 'concurrent bytes', { flag: 'wx' });
    return link(from, to);
  });
  assert.throws(() => movePage(f.root, source), code('EXISTS'));
  assert.equal(f.read(source), 'source bytes'); assert.equal(f.read(destination), 'concurrent bytes');
  assert.equal(fs.existsSync(f.target('reference/projects/INDEX.md')), false);
});

test('source removal failure leaves both copies and reports the incomplete move', t => {
  const f = fixture(t), source = 'reference/projects/item.md', destination = 'reference/projects/archive/item.md';
  f.write(source, 'preserved bytes');
  const unlink = t.mock.method(fs, 'unlinkSync', () => { throw Object.assign(new Error('removal denied'), { code: 'EACCES' }); });
  assert.throws(() => movePage(f.root, source), error => error.code === 'EACCES' && /Destination was published but source removal failed/.test(error.message));
  unlink.mock.restore();
  assert.equal(f.read(source), 'preserved bytes'); assert.equal(f.read(destination), 'preserved bytes');
  assert.throws(() => movePage(f.root, source), code('EXISTS'));
  assert.equal(fs.existsSync(f.target('reference/projects/INDEX.md')), false);
});


test('create refuses a destination that appears just before publication', t => {
  const f = fixture(t), destination = 'reference/projects/item.md';
  const link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (from, to) => {
    fs.writeFileSync(to, 'concurrent page bytes', { flag: 'wx' });
    return link(from, to);
  });
  assert.throws(() => createPage(f.root, destination, 'new page bytes'), code('EXISTS'));
  assert.equal(f.read(destination), 'concurrent page bytes');
  assert.deepEqual(fs.readdirSync(f.target('reference/projects')), ['item.md']);
});
