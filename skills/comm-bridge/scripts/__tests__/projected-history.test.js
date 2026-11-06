import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture as storeFixture } from './c4-v2-test-helpers.js';
import { createQueryHandlers } from '../c4-v2-cli.js';
import { escapeText } from '../c4-query-format.js';
import { projectC4Content } from '../c4-content-projection.js';
import { CONTENT_PREFIX } from '../c4-content-schema.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url)));
const hidden = 'host_only_secret_1987';
const base = structuredClone(fixtures.valid.find(item => item.name === 'markdown').envelope);
base.fallbackText = 'visible matchneedle 文本'; base.blocks[0].data.text = hidden.repeat(200);
const encode = envelope => CONTENT_PREFIX + JSON.stringify(envelope);
const valid = encode(base);
const nested = encode({ ...base, messageId: 'nested_marker', fallbackText: CONTENT_PREFIX + 'literal fallback' });
const broken = CONTENT_PREFIX + '{"host":"' + hidden + '"';
const plain = 'ordinary {"json":true}\n中🚀\\text';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-history-'));
  let ownedDb;
  t.after(() => { if (ownedDb?.open) ownedDb.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'instance'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmux') };
  delete env.TMUX; delete env.ZYLOS_SESSION_GROUP; delete env.ZYLOS_RUN_ID;
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    fs.mkdirSync(env[key], { recursive: true });
    assert.ok(fs.realpathSync(env[key]).startsWith(root + path.sep));
  }
  fs.mkdirSync(path.join(env.ZYLOS_DIR, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(env.ZYLOS_DIR, '.zylos/config.json'), '{"runtime":"claude","session_mode":"multi"}');
  fs.mkdirSync(path.join(env.ZYLOS_DIR, '.claude/skills/dashboard'), { recursive: true });
  const dir = path.join(env.ZYLOS_DIR, 'comm-bridge'); fs.mkdirSync(dir);
  const { db, store } = storeFixture(t, {}, path.join(dir, 'c4.db')); ownedDb = db;
  const invoke = (script, args) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args],
      { env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  return { root, env, db, store, query: createQueryHandlers(store), invoke };
}
const contents = [plain, valid, broken, nested, fixtures.valid.find(item => item.name === 'answer_single_select').content,
  encode({ ...base, messageId: 'long_fallback', fallbackText: '🚀'.repeat(310) })];
function seed({ store, db }, { pending = false } = {}) {
  return contents.map((content, i) => {
    const row = store.insertConversation(pending ? 'in' : i % 2 ? 'out' : 'in', 'dashboard', 'route', content, { groupName: 'alpha' });
    if (!pending && row.direction === 'in') db.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(row.id);
    return row;
  });
}
const assertProjected = (rows, originals) => {
  assert.equal(rows.length, originals.length);
  for (const [i, row] of rows.entries()) {
    assert.equal(row.content, projectC4Content(originals[i].content, { c4Id: originals[i].id }));
    assert.equal(row.content.includes(hidden), false);
    assert.equal(row.id, originals[i].id);
  }
};

// CLI integration: actual Node entry points, private SQLite and owned env paths
// checked above before spawning. Run for CLI/model-history changes; skip UI-only
// changes. No runtime/PM2/tmux/network, children bounded to 5s, cleanup registered
// before SQLite creation; raw business APIs are tested separately below.
test('CLI fetch branches project full rows once in both JSON and default output', async t => {
  const f = fixture(t), originals = seed(f), begin = String(originals[0].id), end = String(originals.at(-1).id);
  const branches = [
    ['range', ['--begin', begin, '--end', end]], ['since', ['--since', '2000-01-01']],
    ['unsummarized', ['--unsummarized', '--group', 'dashboard:alpha']],
    ['combined', ['--origin-sync', '--group', 'dashboard:alpha']],
    ['raw', ['--origin-sync', '--group', 'dashboard:alpha', '--raw-only', '--after', '0']],
  ];
  for (const [name, args] of branches) for (const json of [false, true]) await t.test(`${name} ${json ? 'JSON' : 'default'}`, () => {
    const output = f.invoke('../c4-fetch.js', [...args, ...(json ? ['--json'] : [])]);
    assert.equal(output.includes(hidden), false);
    if (json || name === 'combined') {
      const value = JSON.parse(output), data = json ? value.data : value;
      assertProjected(name === 'raw' ? data : data.rows, originals);
    } else {
      for (const row of originals) assert.ok(output.includes(projectC4Content(row.content, { c4Id: row.id })));
    }
  });
  for (const json of [false, true]) await t.test(`recent ${json ? 'JSON' : 'default'}`, () => {
    const output = f.invoke('../c4-db.js', ['recent', '20', ...(json ? ['--json'] : [])]);
    const value = JSON.parse(output); assertProjected(json ? value.data : value, originals);
  });
  const originalRows = JSON.parse(f.invoke('./fixtures/read-original-history.js', [begin, end]));
  assert.deepEqual(originalRows.map(row => row.content), contents);
  assert.deepEqual(f.store.getUnsummarizedConversations('dashboard:alpha', { upToConversationId: Number(end) }).map(row => row.content), contents);
  assert.deepEqual(f.store.queries.originCombined('dashboard:alpha').rows.map(row => row.content), contents);
});

// Absorbed integration: real query/formatters and private --out files. Run for
// absorbed projection/export changes; skip unrelated runtime or UI changes.
// CLI children are bounded to 5s; no services are started, and every export
// remains inside the owned short TMPDIR fixture.
test('absorbed pages, full fields and exports measure projected text without changing raw reconciliation', t => {
  const f = fixture(t), originals = seed(f, { pending: true });
  const { runId } = f.store.beginModeTransition('single', 'multi');
  f.store.setDrainFence('*'); f.store.absorbForTransition(runId);
  const absorbed = originals.filter(row => row.direction === 'in');
  for (const json of [false, true]) {
    const cli = args => f.invoke('../c4-fetch.js', ['--absorbed', '--run-id', runId, ...args, ...(json ? ['--json'] : [])]);
    const page = cli([]); assert.equal(page.includes(hidden), false);
    if (json) {
      const { items } = JSON.parse(page).data;
      assert.equal(items.length, absorbed.length);
      for (const [i, item] of items.entries()) {
        const text = projectC4Content(absorbed[i].content, { c4Id: absorbed[i].id });
        assert.equal(item.text, [...text].slice(0, 300).join(''));
        assert.equal(item.textBytes, Buffer.byteLength(text)); assert.equal(item.textTruncated, [...text].length > 300);
      }
    }
    for (const row of absorbed) for (const field of ['text', 'endpoint']) {
      const text = field === 'text' ? projectC4Content(row.content, { c4Id: row.id }) : row.endpoint_id;
      const output = cli(['--id', String(row.id), '--field', field]); assert.equal(output.includes(hidden), false);
      if (json) { const data = JSON.parse(output).data; assert.equal(data.data, text); assert.equal(data.bytes, Buffer.byteLength(text)); }
      else assert.equal(output, `absorbed-full run=${runId} id=${row.id} field=${field} bytes=${Buffer.byteLength(text)}\ndata: ${escapeText(text)}\nend id=${row.id} field=${field}\n`);
      const out = path.join(f.root, `${row.id}-${field}-${json}.txt`);
      const receipt = cli(['--id', String(row.id), '--field', field, '--out', out]);
      assert.equal(fs.readFileSync(out, 'utf8'), text); assert.equal(receipt.includes(hidden), false);
      if (json) assert.equal(JSON.parse(receipt).data.bytes, Buffer.byteLength(text));
    }
  }
  assert.deepEqual(f.store.queries.readAbsorbed(runId).rows.map(row => row.content), absorbed.map(row => row.content));
});

test('group preview projects before Unicode truncation and matching across list modes', t => {
  const f = fixture(t);
  for (const [groupName, content] of [['valid', valid], ['broken', broken], ['plain', plain], ['nested', nested]]) {
    const row = f.store.insertConversation('in', 'dashboard', 'route', content, { groupName });
    const groups = f.query.groups({ keyMatch: `dashboard:${groupName}` });
    assert.equal(groups[0].preview.text, [...projectC4Content(content, { c4Id: row.id })].slice(0, 80).join(''));
  }
  for (const json of [false, true]) {
    const invoke = args => {
      const value = JSON.parse(f.invoke('../c4-db.js', ['groups', ...args, ...(json ? ['--json'] : [])]));
      return json ? value.data : value;
    };
    assert.deepEqual(invoke(['--match', hidden]), []);
    const visible = invoke(['--match', 'matchneedle']);
    assert.equal(visible.length, 1); assert.ok(visible[0].preview.text.includes('matchneedle'));
    for (const args of [[], ['--active-since', '0'], ['--key-match', 'dashboard:']]) {
      const result = invoke(args), groups = Array.isArray(result) ? result : result.groups;
      assert.equal(groups.length, 4); assert.equal(JSON.stringify(groups).includes(hidden), false);
    }
  }
  assert.deepEqual(f.query.groups({ match: hidden }), []);
  assert.equal(f.query.groups({ match: 'matchneedle' }).length, 1);
  for (const options of [{}, { activeSince: 0 }, { keyMatch: 'dashboard:' }]) {
    const result = f.query.groups(options), groups = Array.isArray(result) ? result : result.groups;
    assert.equal(JSON.stringify(groups).includes(hidden), false);
  }
});

// CLI integration uses the same isolated fixture and bounded children above.
// Run for group preview/match changes; skip unrelated conversion/runtime work.
test('group matching ignores fallback text and references beyond the 80-character preview', t => {
  const f = fixture(t);
  const keyword = 'beyond_preview_keyword';
  const reference = 'beyond_preview_reference';
  const content = encode({ ...base, messageId: reference, fallbackText: '🚀'.repeat(80) + keyword });
  const row = f.store.insertConversation('in', 'dashboard', 'route', content, { groupName: 'long' });
  const projected = projectC4Content(content, { c4Id: row.id });
  const preview = f.query.groups({ keyMatch: 'dashboard:long' })[0].preview.text;
  assert.equal(preview, '🚀'.repeat(80));
  for (const word of [keyword, reference, `c4_id=${row.id}`]) {
    assert.ok(projected.includes(word), 'the complete projection contains the excluded match');
    assert.equal(preview.includes(word), false);
    assert.deepEqual(f.query.groups({ match: word }), []);
    for (const json of [false, true]) {
      const result = JSON.parse(f.invoke('../c4-db.js', ['groups', '--match', word, ...(json ? ['--json'] : [])]));
      assert.deepEqual(json ? result.data : result, []);
    }
  }
  assert.equal(f.query.groups({ match: '🚀' }).length, 1);
});

// This branch has no BeforeSend implementation. The marker only fixes that
// direct insert does not call a hook; manually running its script is not a
// c4-send positive control. Real channel-hook coverage belongs to integration.
// No real send/channel/network is invoked.
test('insert receipts project text but direct Dashboard insertion still bypasses BeforeSend', t => {
  const f = fixture(t), component = path.join(f.env.ZYLOS_DIR, '.claude/skills/dashboard');
  const marker = path.join(f.root, 'hook-called');
  fs.writeFileSync(path.join(component, 'before-send.js'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'called'); console.log('{"action":"abort"}');`);
  fs.writeFileSync(path.join(component, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(component, 'SKILL.md'), '---\nname: dashboard\nc4:\n  before_send:\n    hook_id: dashboard-shape\n    entry: before-send.js\n    timeout_ms: 1000\n---\n');
  // Verify that the sentinel script can write its marker in this fixture.
  const control = spawnSync(process.execPath, [path.join(component, 'before-send.js')], { env: f.env, encoding: 'utf8', timeout: 5000 });
  assert.equal(control.status, 0, control.stderr); assert.equal(fs.readFileSync(marker, 'utf8'), 'called'); fs.unlinkSync(marker);
  for (const json of [false, true]) {
    const output = f.invoke('../c4-db.js', ['insert', 'out', 'dashboard', 'route', valid, ...(json ? ['--json'] : [])]);
    const value = JSON.parse(json ? output : output.slice('Inserted: '.length)), row = json ? value.data : value;
    assert.equal(row.content, projectC4Content(valid, { c4Id: row.id }));
    assert.equal(f.db.prepare('SELECT content FROM conversations WHERE id=?').get(row.id).content, valid);
    assert.equal(fs.existsSync(marker), false);
  }
  const raw = f.invoke('../c4-db.js', ['insert', 'out', 'system', 'null', plain]);
  const row = JSON.parse(raw.slice('Inserted: '.length)); assert.equal(row.content, plain);
});

test('CLI and SQL documentation preserve projection and direct-insert boundaries', () => {
  const skill = fs.readFileSync(new URL('../../SKILL.md', import.meta.url), 'utf8');
  const usage = fs.readFileSync(new URL('../../references/c4-db.md', import.meta.url), 'utf8');
  for (const text of [skill, usage]) {
    assert.ok(text.includes('projectC4Content(content, { c4Id: row.id })'));
    assert.ok(text.includes('insert out dashboard')); assert.match(text, /bypasses\s+BeforeSend/);
  }
});
