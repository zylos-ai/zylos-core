import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPage, rebuild, movePage, moveOld } from '../reference-index.js';

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

test('reference operations reject symlinks escaping their permitted destinations', t => {
  const f = fixture(t);
  fs.mkdirSync(f.target('reference'), { recursive: true });
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, f.target('reference/projects'));
  assert.throws(() => createPage(f.root, 'reference/projects/item.md', 'no'), code('PATH_NOT_ALLOWED'));
  assert.throws(() => rebuild(f.root), code('PATH_NOT_ALLOWED'));
  assert.equal(fs.readdirSync(outside).length, 0);
});
