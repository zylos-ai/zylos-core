import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture as storeFixture } from './c4-v2-test-helpers.js';
import { createQueryHandlers } from '../c4-v2-cli.js';
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
